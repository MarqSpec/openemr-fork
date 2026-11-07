<?php

/**
 * Isolated tests for the AgentForge document-ingest run's watermark and retry rules: a failed forward
 * is scanned again on a later run even when a later document in the same run was accepted; a document the
 * sidecar keeps rejecting is given up on after a bounded number of runs instead of holding the watermark back
 * forever; and a run in which the sidecar accepted nothing (an outage) never counts against a document. Runs
 * against in-memory settings, a scripted gateway and a recording logger, no database. Synthetic data only.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge
 * @copyright Copyright (c) 2026 AgentForge
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Tests\Isolated\Modules\AgentForge;

use OpenEMR\Modules\AgentForge\Ingest\DocumentIngestService;
use OpenEMR\Modules\AgentForge\Ingest\IngestDocument;
use OpenEMR\Modules\AgentForge\Ingest\IngestForwardResult;
use OpenEMR\Modules\AgentForge\Ingest\IngestRetry;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use Psr\Log\LogLevel;

final class DocumentIngestRetryTest extends TestCase
{
    private const MODULE_SRC = __DIR__ . '/../../../../../interface/modules/custom_modules/oe-module-agentforge/src/';

    private const INGEST_URI = 'http://agent-forge-api.test.internal:8080/documents/ingest';
    private const VALID_MAP = '{"12":"lab_pdf","15":"intake_form"}';

    // Synthetic stand-ins for what a real document carries; none of them may reach a log line.
    private const PATIENT_UUID = 'a1b2c3d4-0000-4000-8000-00000000af01';
    private const FILENAME = 'af-demo-synthetic-lab.pdf';

    private RecordingLogger $logger;
    private InMemoryIngestSettings $settings;

    public static function setUpBeforeClass(): void
    {
        // The module namespace is registered by the module bootstrap at runtime, not by composer, so load the
        // classes directly (as the other AgentForge module tests do). The interface precedes its implementer.
        foreach (
            [
                'Ingest/IngestSettings',
                'Ingest/IngestRetry',
                'Ingest/IngestDocument',
                'Ingest/IngestForwardResult',
                'Ingest/IngestDocumentGateway',
                'Ingest/IngestPayload',
                'Ingest/IngestPayloadReader',
                'Ingest/SidecarIngestClient',
                'Ingest/IngestForwarder',
                'Ingest/IngestSkipReason',
                'Config/AgentForgeGlobalConfig',
                'Ingest/DocumentIngestService',
            ] as $file
        ) {
            require_once self::MODULE_SRC . $file . '.php';
        }
        require_once __DIR__ . '/InMemoryIngestSettings.php';
        require_once __DIR__ . '/FakeIngestDocumentGateway.php';
        require_once __DIR__ . '/RecordingLogger.php';
    }

    protected function setUp(): void
    {
        $this->logger = new RecordingLogger();
        $this->settings = new InMemoryIngestSettings(ingestUri: self::INGEST_URI, categoryMapSource: self::VALID_MAP);
    }

    public function testAFailedForwardIsRetriedOnTheNextRunEvenThoughALaterDocumentWasAccepted(): void
    {
        // The defect: 10 fails, 11 is accepted in the same run, the watermark jumps to 11, and 10 is
        // never scanned again.
        $gateway = new FakeIngestDocumentGateway($this->documents(10, 11), failingIds: [10]);
        $service = $this->service($gateway);

        $service->run();

        self::assertSame([10, 11], $gateway->takeForwarded());
        self::assertSame(9, $this->settings->watermark, 'the watermark stops just below the failed document');

        $gateway->failingIds = [];
        $service->run();

        self::assertSame([10, 11], $gateway->takeForwarded(), 'the failed document is forwarded again');
        self::assertSame(11, $this->settings->watermark);
        self::assertNull($this->settings->retry);
    }

    public function testARunWithNoFailureAdvancesToTheHighestDocumentAsBefore(): void
    {
        $gateway = new FakeIngestDocumentGateway($this->documents(10, 11, 12));
        $service = $this->service($gateway);

        $service->run();
        self::assertSame([10, 11, 12], $gateway->takeForwarded());
        self::assertSame(12, $this->settings->watermark);

        $service->run();
        self::assertSame([], $gateway->takeForwarded(), 'nothing is forwarded twice once all are accepted');
        self::assertSame(12, $this->settings->watermark);
        self::assertSame([], $this->logger->records);
    }

    public function testTheWatermarkStopsBelowTheLowestOfSeveralFailures(): void
    {
        $gateway = new FakeIngestDocumentGateway($this->documents(10, 11, 12, 13), failingIds: [12, 11]);

        $this->service($gateway)->run();

        self::assertSame([10, 11, 12, 13], $gateway->takeForwarded());
        self::assertSame(10, $this->settings->watermark);
        self::assertEquals(new IngestRetry(11, 1, 13), $this->settings->retry);
    }

    public function testADocumentThatKeepsFailingIsGivenUpOnAfterTheLimitAndNothingAfterItIsHeldBack(): void
    {
        // Each run brings a new upload the sidecar accepts, so each run is proof the sidecar works and 10 alone
        // is the problem.
        $gateway = new FakeIngestDocumentGateway($this->documents(10), failingIds: [10]);
        $service = $this->service($gateway);

        for ($run = 1; $run < DocumentIngestService::MAX_FAILED_RUNS; $run++) {
            $gateway->addDocument($this->document(10 + $run));
            $service->run();
            self::assertSame(9, $this->settings->watermark, "run $run still holds the watermark");
            self::assertEquals(new IngestRetry(10, $run, 10 + $run), $this->settings->retry);
        }
        self::assertSame([], $this->logger->atLevel(LogLevel::ERROR));

        $gateway->addDocument($this->document(100));
        $service->run();

        self::assertSame(100, $this->settings->watermark, 'the limit is reached: the watermark moves past 10');
        self::assertNull($this->settings->retry);
        $errors = $this->logger->atLevel(LogLevel::ERROR);
        self::assertCount(1, $errors);
        self::assertSame(
            ['documentId' => 10, 'failedRuns' => DocumentIngestService::MAX_FAILED_RUNS, 'reason' => 'rejected'],
            $errors[0]['context']
        );
        self::assertStringContainsString('sidecar', $errors[0]['message']);

        $gateway->takeForwarded();
        $service->run();
        self::assertSame([], $gateway->takeForwarded(), 'the abandoned document is not scanned again');
    }

    public function testReSendingAlreadyAcceptedDocumentsIsNotProofTheSidecarIsWorking(): void
    {
        // 10 fails once while 11 is newly accepted. After that the sidecar's extraction is down but it still
        // answers 200 for 11, which is only being re-sent because 10 holds the watermark. Those answers must not
        // run the count up and abandon 10 during the outage.
        $gateway = new FakeIngestDocumentGateway($this->documents(10, 11), failingIds: [10]);
        $service = $this->service($gateway);
        $service->run();
        self::assertEquals(new IngestRetry(10, 1, 11), $this->settings->retry);

        for ($run = 0; $run < DocumentIngestService::MAX_FAILED_RUNS * 3; $run++) {
            $service->run();
        }

        self::assertSame(9, $this->settings->watermark);
        self::assertEquals(new IngestRetry(10, 1, 11), $this->settings->retry);
        self::assertSame([], $this->logger->atLevel(LogLevel::ERROR));

        // A genuinely new upload the sidecar accepts is proof, and does count.
        $gateway->addDocument($this->document(12));
        $service->run();
        self::assertEquals(new IngestRetry(10, 2, 12), $this->settings->retry);
    }

    public function testAHeldDocumentThatIsDeletedReleasesTheWatermark(): void
    {
        $gateway = new FakeIngestDocumentGateway($this->documents(10, 11), failingIds: [10]);
        $service = $this->service($gateway);
        $service->run();
        self::assertSame(9, $this->settings->watermark);

        // The query excludes deleted documents, so 10 simply stops being listed.
        $gateway->removeDocument(10);
        $service->run();

        self::assertSame(11, $this->settings->watermark);
        self::assertNull($this->settings->retry);
        self::assertSame([], $this->logger->atLevel(LogLevel::ERROR));
    }

    public function testGivingUpOnTheLowestFailureLeavesTheNextOneWithAFreshCount(): void
    {
        // 12 was accepted in an earlier run and is only re-sent; 13 is new, so this run counts.
        $gateway = new FakeIngestDocumentGateway($this->documents(10, 11, 12, 13), failingIds: [10, 11]);
        $this->settings->retry = new IngestRetry(10, DocumentIngestService::MAX_FAILED_RUNS - 1, 12);

        $this->service($gateway)->run();

        self::assertSame(10, $this->settings->watermark, 'it now stops below 11, the next failure');
        self::assertEquals(new IngestRetry(11, 1, 13), $this->settings->retry);
        $errors = $this->logger->atLevel(LogLevel::ERROR);
        self::assertCount(1, $errors);
        self::assertSame(10, $errors[0]['context']['documentId']);
    }

    public function testARunWhereTheSidecarAcceptedNothingNeverCountsAgainstADocument(): void
    {
        // An outage: every forward fails. Far more runs than the limit must not give up on anything, or a
        // long outage would silently drop documents one by one.
        $gateway = new FakeIngestDocumentGateway($this->documents(10, 11, 12), failingIds: [10, 11, 12]);
        $service = $this->service($gateway);

        for ($run = 0; $run < DocumentIngestService::MAX_FAILED_RUNS * 3; $run++) {
            $service->run();
        }

        self::assertSame(9, $this->settings->watermark);
        self::assertEquals(new IngestRetry(10, 0, 9), $this->settings->retry);
        self::assertSame([], $this->logger->atLevel(LogLevel::ERROR));

        $gateway->failingIds = [];
        $service->run();
        self::assertSame(12, $this->settings->watermark, 'when the sidecar returns, everything is forwarded');
        self::assertNull($this->settings->retry);
    }

    public function testTheCountRestartsWhenADifferentDocumentBecomesTheLowestFailure(): void
    {
        $gateway = new FakeIngestDocumentGateway($this->documents(10, 11, 12), localFailures: [
            10 => IngestForwardResult::Unreadable,
            12 => IngestForwardResult::Unreadable,
        ]);
        $service = $this->service($gateway);
        $service->run();
        $service->run();
        self::assertEquals(new IngestRetry(10, 2, 11), $this->settings->retry);

        // 10 recovers; 12 still fails and is now the lowest failure, with no history of its own.
        $gateway->localFailures = [12 => IngestForwardResult::Unreadable];
        $service->run();

        self::assertSame(11, $this->settings->watermark);
        self::assertEquals(new IngestRetry(12, 1, 11), $this->settings->retry);
    }

    #[DataProvider('documentFactReasons')]
    public function testAFactAboutTheDocumentHoldsTheWatermarkAndIsGivenUpOnWithItsOwnReasonAndRemedy(
        string $reason,
        string $expectedCause,
        string $expectedRemedy
    ): void {
        // Nothing else is uploaded, so the sidecar accepts nothing - yet a missing patient UUID, an empty file or
        // a missing document UUID is no outage's doing, so it counts every run and is eventually given up on.
        $failure = IngestForwardResult::from($reason);
        $gateway = new FakeIngestDocumentGateway($this->documents(10), localFailures: [10 => $failure]);
        $service = $this->service($gateway);

        for ($run = 1; $run < DocumentIngestService::MAX_FAILED_RUNS; $run++) {
            $service->run();
            self::assertSame(9, $this->settings->watermark, "run $run holds the watermark");
            self::assertEquals(new IngestRetry(10, $run, 9), $this->settings->retry);
        }
        self::assertSame([], $this->logger->atLevel(LogLevel::ERROR));

        $service->run();

        self::assertSame(10, $this->settings->watermark);
        self::assertNull($this->settings->retry);
        $this->assertGaveUpOn10($reason, $expectedCause, $expectedRemedy);
    }

    /**
     * @return array<string, array{string, string, string}>
     *
     * @codeCoverageIgnore Data providers run before coverage instrumentation starts.
     */
    public static function documentFactReasons(): array
    {
        return [
            'patient without a FHIR UUID' => ['no_patient_uuid', 'no FHIR UUID', 'Give the patient a UUID'],
            'zero-byte file' => ['empty_file', 'file is empty', 'Upload the document again with its content'],
            'document without a UUID' => [
                'no_document_uuid',
                'no UUID of its own',
                'Re-upload the document so it gets',
            ],
        ];
    }

    public function testAnUnreadableFileCountsOnlyWhileOtherFilesAreBeingRead(): void
    {
        // Another document is read fine every run (here: sent and rejected, so the sidecar proves nothing), which
        // shows storage works and 10 alone is unreadable.
        $gateway = new FakeIngestDocumentGateway(
            $this->documents(10, 11),
            failingIds: [11],
            localFailures: [10 => IngestForwardResult::Unreadable]
        );
        $service = $this->service($gateway);

        for ($run = 1; $run < DocumentIngestService::MAX_FAILED_RUNS; $run++) {
            $service->run();
            self::assertEquals(new IngestRetry(10, $run, 9), $this->settings->retry);
        }
        self::assertSame([], $this->logger->atLevel(LogLevel::ERROR));

        $service->run();

        self::assertSame(10, $this->settings->watermark, 'the rejected 11 is now the one held');
        $this->assertGaveUpOn10('unreadable', 'file could not be read', 'Check the document storage');
    }

    public function testAStorageOutageNeverCountsAgainstADocument(): void
    {
        // An unmounted volume, a CouchDB outage or a missing encryption key: nothing can be read. Far more runs
        // than the limit must not abandon anything, or one document would be dropped per counted hour.
        $gateway = new FakeIngestDocumentGateway($this->documents(10, 11, 12), localFailures: [
            10 => IngestForwardResult::Unreadable,
            11 => IngestForwardResult::Unreadable,
            12 => IngestForwardResult::Unreadable,
        ]);
        $service = $this->service($gateway);

        for ($run = 0; $run < DocumentIngestService::MAX_FAILED_RUNS * 3; $run++) {
            $service->run();
        }

        self::assertSame(9, $this->settings->watermark);
        self::assertEquals(new IngestRetry(10, 0, 9), $this->settings->retry);
        self::assertSame([], $this->logger->atLevel(LogLevel::ERROR));

        $gateway->localFailures = [];
        $service->run();
        self::assertSame(12, $this->settings->watermark, 'when storage returns, everything is forwarded');
        self::assertNull($this->settings->retry);
    }

    public function testALoneUnreadableDocumentIsPresumedAStorageOutageAndNeverGivenUpOn(): void
    {
        $gateway = new FakeIngestDocumentGateway(
            $this->documents(10),
            localFailures: [10 => IngestForwardResult::Unreadable]
        );
        $service = $this->service($gateway);

        for ($run = 0; $run < DocumentIngestService::MAX_FAILED_RUNS * 2; $run++) {
            $service->run();
        }

        self::assertEquals(new IngestRetry(10, 0, 9), $this->settings->retry);
        self::assertSame([], $this->logger->atLevel(LogLevel::ERROR));
    }

    public function testTheLowestFailureWinsEvenWhenTheScanIsNotInIdOrder(): void
    {
        // The real query orders by id, but where the watermark stops must not depend on it.
        $gateway = new FakeIngestDocumentGateway(
            $this->documents(10, 11, 12, 13),
            failingIds: [12, 11],
            newestFirst: true
        );

        $this->service($gateway)->run();

        self::assertSame([13, 12, 11, 10], $gateway->takeForwarded());
        self::assertSame(10, $this->settings->watermark);
        self::assertEquals(new IngestRetry(11, 1, 13), $this->settings->retry);
    }

    public function testEachGiveUpReasonHasItsOwnMessageAndOnlyAFailureCanBeGivenUpOn(): void
    {
        $messages = [];
        $reasons = ['rejected', 'no_patient_uuid', 'unreadable', 'empty_file', 'no_document_uuid'];
        foreach ($reasons as $reason) {
            $messages[] = IngestForwardResult::from($reason)->giveUpMessage();
        }
        self::assertCount(count($reasons), array_unique($messages));

        $this->expectException(\LogicException::class);
        IngestForwardResult::Forwarded->giveUpMessage();
    }

    public function testALoneRejectedDocumentIsPresumedAnOutageAndNeverGivenUpOn(): void
    {
        // The counterpart of the local-failure test above: the same lone document, but rejected by the sidecar
        // rather than failing inside OpenEMR, counts against nothing because nothing else was accepted.
        $rejected = new FakeIngestDocumentGateway($this->documents(10), failingIds: [10]);
        for ($run = 0; $run < DocumentIngestService::MAX_FAILED_RUNS * 2; $run++) {
            $this->service($rejected)->run();
        }
        self::assertEquals(new IngestRetry(10, 0, 9), $this->settings->retry);
        self::assertSame([], $this->logger->atLevel(LogLevel::ERROR));
    }

    public function testALocalFailureAndALaterAcceptedDocumentCountOnceNotTwice(): void
    {
        $gateway = new FakeIngestDocumentGateway(
            $this->documents(10, 11),
            localFailures: [10 => IngestForwardResult::NoPatientUuid]
        );

        $this->service($gateway)->run();

        self::assertSame(9, $this->settings->watermark);
        self::assertEquals(new IngestRetry(10, 1, 11), $this->settings->retry);
    }

    public function testALocalFailureThatClearsIsForwardedAndReleasesTheWatermark(): void
    {
        // The patient's UUID is generated between runs: the same document now forwards.
        $gateway = new FakeIngestDocumentGateway(
            $this->documents(10, 11),
            localFailures: [10 => IngestForwardResult::NoPatientUuid]
        );
        $service = $this->service($gateway);
        $service->run();

        $gateway->localFailures = [];
        $service->run();

        self::assertSame(11, $this->settings->watermark);
        self::assertNull($this->settings->retry);
        self::assertSame([], $this->logger->atLevel(LogLevel::ERROR));
    }

    public function testTheRetryIsOnlyWrittenWhenItChanges(): void
    {
        $gateway = new FakeIngestDocumentGateway($this->documents(10), failingIds: [10]);
        $service = $this->service($gateway);

        $service->run();
        $service->run();
        $service->run();

        // No other document was accepted, so the count never moved: one write, not one per run.
        self::assertEquals(new IngestRetry(10, 0, 9), $this->settings->retry);
        self::assertSame(1, $this->settings->retryWrites);
    }

    #[DataProvider('retryStrings')]
    public function testRetryStateParsesFromItsStoredForm(
        string $stored,
        ?int $documentId,
        ?int $failedRuns,
        ?int $acceptedThrough
    ): void {
        $retry = IngestRetry::fromString($stored);

        if ($documentId === null || $failedRuns === null || $acceptedThrough === null) {
            self::assertNull($retry);
            return;
        }
        self::assertNotNull($retry);
        self::assertSame($documentId, $retry->documentId);
        self::assertSame($failedRuns, $retry->failedRuns);
        self::assertSame($acceptedThrough, $retry->acceptedThrough);
        self::assertSame($stored, $retry->toString());
    }

    /**
     * @return array<string, array{string, ?int, ?int, ?int}>
     *
     * @codeCoverageIgnore Data providers run before coverage instrumentation starts.
     */
    public static function retryStrings(): array
    {
        return [
            'a document, a count and a mark' => ['10:3:12', 10, 3, 12],
            'zeros' => ['10:0:0', 10, 0, 0],
            'never stored' => ['', null, null, null],
            'the two-part form' => ['10:3', null, null, null],
            'no count' => ['10', null, null, null],
            'a zero id' => ['0:3:5', null, null, null],
            'a negative count' => ['10:-1:5', null, null, null],
            'a negative mark' => ['10:1:-5', null, null, null],
            'trailing text' => ['10:3:12 abc', null, null, null],
            'not numbers' => ['x:y:z', null, null, null],
        ];
    }

    #[DataProvider('invalidRetryValues')]
    public function testRetryStateRefusesValuesItCouldNotHaveParsed(int $documentId, int $failedRuns, int $mark): void
    {
        $this->expectException(\DomainException::class);

        new IngestRetry($documentId, $failedRuns, $mark);
    }

    /**
     * @return array<string, array{int, int, int}>
     *
     * @codeCoverageIgnore Data providers run before coverage instrumentation starts.
     */
    public static function invalidRetryValues(): array
    {
        return [
            'a zero document id' => [0, 0, 0],
            'a negative document id' => [-4, 0, 0],
            'a negative count' => [10, -1, 0],
            'a negative mark' => [10, 0, -1],
        ];
    }

    public function testNothingThatReachesALogLineCarriesPatientDataOrDocumentContent(): void
    {
        $gateway = new FakeIngestDocumentGateway($this->documents(10, 11), failingIds: [10]);
        $this->settings->retry = new IngestRetry(10, DocumentIngestService::MAX_FAILED_RUNS - 1, 9);

        $this->service($gateway)->run();

        self::assertNotSame([], $this->logger->records);
        $logged = var_export($this->logger->records, true);
        self::assertStringNotContainsString(self::PATIENT_UUID, $logged);
        self::assertStringNotContainsString(self::FILENAME, $logged);
        self::assertStringNotContainsString('lab_pdf', $logged);
    }

    private function assertGaveUpOn10(string $reason, string $expectedCause, string $expectedRemedy): void
    {
        $errors = $this->logger->atLevel(LogLevel::ERROR);
        self::assertCount(1, $errors);
        self::assertSame(
            ['documentId' => 10, 'failedRuns' => DocumentIngestService::MAX_FAILED_RUNS, 'reason' => $reason],
            $errors[0]['context']
        );
        self::assertStringContainsString($expectedCause, $errors[0]['message']);
        self::assertStringContainsString($expectedRemedy, $errors[0]['message']);
        self::assertStringNotContainsString('sidecar', $errors[0]['message'], 'the sidecar was never asked');
        self::assertStringNotContainsString(self::PATIENT_UUID, var_export($this->logger->records, true));
    }

    private function service(FakeIngestDocumentGateway $gateway): DocumentIngestService
    {
        return new DocumentIngestService($this->settings, $this->logger, $gateway);
    }

    /**
     * @return list<IngestDocument>
     */
    private function documents(int ...$ids): array
    {
        return array_map($this->document(...), array_values($ids));
    }

    private function document(int $id): IngestDocument
    {
        return new IngestDocument($id, 'lab_pdf', 'application/pdf', self::FILENAME, self::PATIENT_UUID);
    }
}
