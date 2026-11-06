<?php

/**
 * Isolated tests for IngestForwarder: every way a document can fail before or at the sidecar maps to a
 * typed result; a document OpenEMR cannot read - OpenEMR's Document throws for a missing file, a failed
 * decryption and an expired document - is reported as Unreadable instead of aborting the run, and the log line
 * carries the document id and the exception class but never the exception message, a file path or a file name.
 * Runs against a scripted reader, a mocked HTTP client and a recording logger, no database. Synthetic data only.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge
 * @copyright Copyright (c) 2026 AgentForge
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Tests\Isolated\Modules\AgentForge;

use GuzzleHttp\Client;
use GuzzleHttp\Handler\MockHandler;
use GuzzleHttp\HandlerStack;
use GuzzleHttp\Psr7\Response;
use OpenEMR\Modules\AgentForge\Ingest\DocumentIngestService;
use OpenEMR\Modules\AgentForge\Ingest\IngestDocument;
use OpenEMR\Modules\AgentForge\Ingest\IngestForwarder;
use OpenEMR\Modules\AgentForge\Ingest\IngestForwardResult;
use OpenEMR\Modules\AgentForge\Ingest\IngestPayload;
use OpenEMR\Modules\AgentForge\Ingest\IngestRetry;
use OpenEMR\Modules\AgentForge\Ingest\SidecarIngestClient;
use PHPUnit\Framework\TestCase;
use Psr\Log\LogLevel;

final class IngestForwarderTest extends TestCase
{
    private const MODULE_SRC = __DIR__ . '/../../../../../interface/modules/custom_modules/oe-module-agentforge/src/';

    private const INGEST_URI = 'http://agent-forge-api.test.internal:8080/documents/ingest';
    private const VALID_MAP = '{"12":"lab_pdf"}';

    // Synthetic stand-ins for what a real failure carries; none of them may reach a log line.
    private const PATIENT_UUID = 'a1b2c3d4-0000-4000-8000-00000000af01';
    private const PATIENT_FHIR_ID = 'a1b2c3d4-0000-4000-8000-00000000af0f';
    private const DOCUMENT_REFERENCE_ID = 'f0e1d2c3-0000-4000-8000-00000000af02';
    private const FILENAME = 'af-demo-synthetic-lab.pdf';
    private const CONTENT = '%PDF-1.4 SYNTHETIC AF-DEMO LAB REPORT BYTES';
    private const PATH = '/var/www/sites/default/documents/1234/af-demo-synthetic-lab.pdf';
    private const EXCEPTION_MESSAGE = 'Unable to read ' . self::PATH . ' for patient pid 1234';

    private RecordingLogger $logger;

    public static function setUpBeforeClass(): void
    {
        // The module namespace is registered by the module bootstrap at runtime, not by composer, so load the
        // classes directly (as the other AgentForge module tests do). Interfaces precede their implementers.
        foreach (
            [
                'Ingest/IngestSettings',
                'Ingest/IngestRetry',
                'Ingest/IngestDocument',
                'Ingest/IngestForwardResult',
                'Ingest/IngestDocumentGateway',
                'Ingest/IngestPayload',
                'Ingest/IngestPayloadReader',
                'Ingest/IngestSkipReason',
                'Ingest/SidecarIngestClient',
                'Ingest/IngestForwarder',
                'Config/AgentForgeGlobalConfig',
                'Ingest/DocumentIngestService',
            ] as $file
        ) {
            require_once self::MODULE_SRC . $file . '.php';
        }
        require_once __DIR__ . '/InMemoryIngestSettings.php';
        require_once __DIR__ . '/FakeIngestDocumentGateway.php';
        require_once __DIR__ . '/ScriptedPayloadReader.php';
        require_once __DIR__ . '/RecordingLogger.php';
    }

    protected function setUp(): void
    {
        $this->logger = new RecordingLogger();
    }

    public function testAThrowingReaderIsReportedAsUnreadableAndNeverReachesTheSidecar(): void
    {
        $reader = new ScriptedPayloadReader([10 => new \RuntimeException(self::EXCEPTION_MESSAGE)]);
        $http = new MockHandler([]);

        $result = $this->forwarder($reader, $http)->forward(self::INGEST_URI, $this->document(10));

        self::assertSame(IngestForwardResult::Unreadable, $result);
        self::assertSame(1, $reader->reads);
        self::assertCount(0, $http, 'the sidecar is not asked about a document that could not be read');
    }

    public function testTheUnreadableLogLineCarriesTheDocumentIdAndExceptionClassOnly(): void
    {
        $reader = new ScriptedPayloadReader([10 => new \RuntimeException(self::EXCEPTION_MESSAGE)]);

        $this->forwarder($reader, new MockHandler([]))->forward(self::INGEST_URI, $this->document(10));

        $warnings = $this->logger->warnings();
        self::assertCount(1, $warnings);
        self::assertSame(
            ['documentId' => 10, 'exceptionClass' => \RuntimeException::class],
            $warnings[0]['context']
        );
        $this->assertNothingSensitiveLogged();
    }

    public function testAnExpiredDocumentExceptionIsReportedAsUnreadableToo(): void
    {
        // Document::get_data() throws a BadMethodCallException (a LogicException) for an expired document.
        $reader = new ScriptedPayloadReader([10 => new \BadMethodCallException(self::EXCEPTION_MESSAGE)]);

        $result = $this->forwarder($reader, new MockHandler([]))->forward(self::INGEST_URI, $this->document(10));

        self::assertSame(IngestForwardResult::Unreadable, $result);
        self::assertSame(
            ['documentId' => 10, 'exceptionClass' => \BadMethodCallException::class],
            $this->logger->warnings()[0]['context']
        );
        $this->assertNothingSensitiveLogged();
    }

    public function testAnErrorFromTheReaderIsABugAndPropagates(): void
    {
        // The fork forbids catches that swallow an \Error: a TypeError is a bug to surface, not a document to
        // skip. Only an \Exception, which is how OpenEMR's Document reports an unreadable file, is mapped.
        $reader = new ScriptedPayloadReader([10 => new \TypeError(self::EXCEPTION_MESSAGE)]);

        $this->expectException(\TypeError::class);

        $this->forwarder($reader, new MockHandler([]))->forward(self::INGEST_URI, $this->document(10));
    }

    public function testARunContinuesPastAnUnreadableDocumentAndWritesItsState(): void
    {
        // Before the fix the throw aborted the run: document 11 was never forwarded and no state was written.
        $reader = new ScriptedPayloadReader([
            10 => new \RuntimeException(self::EXCEPTION_MESSAGE),
            11 => $this->payload(),
        ]);
        $http = new MockHandler([new Response(200)]);
        $gateway = new FakeIngestDocumentGateway(
            [$this->document(10), $this->document(11)],
            forwarder: $this->forwarder($reader, $http)
        );
        $settings = new InMemoryIngestSettings(ingestUri: self::INGEST_URI, categoryMapSource: self::VALID_MAP);

        (new DocumentIngestService($settings, $this->logger, $gateway))->run();

        self::assertSame([10, 11], $gateway->takeForwarded());
        self::assertSame(9, $settings->watermark);
        self::assertEquals(new IngestRetry(10, 1, 11), $settings->retry);
        $this->assertNothingSensitiveLogged();
    }

    public function testAnUnreadableDocumentIsGivenUpOnWhileOthersAreReadAndNothingSensitiveIsLogged(): void
    {
        $reader = new ScriptedPayloadReader([
            10 => new \RuntimeException(self::EXCEPTION_MESSAGE),
            11 => $this->payload(),
        ]);
        $runs = DocumentIngestService::MAX_FAILED_RUNS;
        $http = new MockHandler(array_fill(0, $runs, new Response(200)));
        $gateway = new FakeIngestDocumentGateway(
            [$this->document(10), $this->document(11)],
            forwarder: $this->forwarder($reader, $http)
        );
        $settings = new InMemoryIngestSettings(ingestUri: self::INGEST_URI, categoryMapSource: self::VALID_MAP);
        $service = new DocumentIngestService($settings, $this->logger, $gateway);

        for ($run = 0; $run < $runs; $run++) {
            $service->run();
        }

        self::assertSame(11, $settings->watermark);
        self::assertNull($settings->retry);
        $errors = $this->logger->atLevel(LogLevel::ERROR);
        self::assertCount(1, $errors);
        self::assertSame(
            ['documentId' => 10, 'failedRuns' => $runs, 'reason' => 'unreadable'],
            $errors[0]['context']
        );
        $this->assertNothingSensitiveLogged();
    }

    public function testAMissingPatientUuidIsReportedWithoutReadingTheDocument(): void
    {
        $reader = new ScriptedPayloadReader([10 => $this->payload()]);

        foreach ([null, ''] as $patientUuid) {
            $result = $this->forwarder($reader, new MockHandler([]))
                ->forward(self::INGEST_URI, $this->document(10, $patientUuid));
            self::assertSame(IngestForwardResult::NoPatientUuid, $result);
        }
        self::assertSame(0, $reader->reads);
        self::assertSame([], $this->logger->records);
    }

    public function testAZeroByteFileIsReportedAsEmptyNotUnreadable(): void
    {
        $reader = new ScriptedPayloadReader([
            10 => new IngestPayload(self::PATIENT_FHIR_ID, self::DOCUMENT_REFERENCE_ID, ''),
        ]);
        $http = new MockHandler([]);

        $result = $this->forwarder($reader, $http)->forward(self::INGEST_URI, $this->document(10));

        self::assertSame(IngestForwardResult::EmptyFile, $result);
        self::assertCount(0, $http);
        self::assertSame([], $this->logger->records);
    }

    public function testADocumentWithoutAUuidOfItsOwnIsReportedAsSuch(): void
    {
        $reader = new ScriptedPayloadReader([10 => new IngestPayload(self::PATIENT_FHIR_ID, '', self::CONTENT)]);
        $http = new MockHandler([]);

        $result = $this->forwarder($reader, $http)->forward(self::INGEST_URI, $this->document(10));

        self::assertSame(IngestForwardResult::NoDocumentUuid, $result);
        self::assertCount(0, $http);
    }

    public function testTheSidecarsAnswerDecidesForwardedOrRejected(): void
    {
        $reader = new ScriptedPayloadReader([10 => $this->payload(), 11 => $this->payload()]);
        $http = new MockHandler([new Response(200), new Response(503)]);
        $forwarder = $this->forwarder($reader, $http);

        self::assertSame(IngestForwardResult::Forwarded, $forwarder->forward(self::INGEST_URI, $this->document(10)));
        self::assertSame(IngestForwardResult::Rejected, $forwarder->forward(self::INGEST_URI, $this->document(11)));
    }

    private function forwarder(ScriptedPayloadReader $reader, MockHandler $http): IngestForwarder
    {
        return new IngestForwarder(
            $reader,
            new SidecarIngestClient(
                new Client(['handler' => HandlerStack::create($http)]),
                $this->logger
            ),
            $this->logger
        );
    }

    private function document(int $id, ?string $patientUuid = self::PATIENT_UUID): IngestDocument
    {
        return new IngestDocument($id, 'lab_pdf', 'application/pdf', self::FILENAME, $patientUuid);
    }

    private function payload(): IngestPayload
    {
        return new IngestPayload(self::PATIENT_FHIR_ID, self::DOCUMENT_REFERENCE_ID, self::CONTENT);
    }

    private function assertNothingSensitiveLogged(): void
    {
        $logged = var_export($this->logger->records, true);
        foreach (
            [
                self::EXCEPTION_MESSAGE,
                self::PATH,
                'pid 1234',
                self::FILENAME,
                self::PATIENT_UUID,
                self::PATIENT_FHIR_ID,
                self::DOCUMENT_REFERENCE_ID,
                self::CONTENT,
            ] as $forbidden
        ) {
            self::assertStringNotContainsString($forbidden, $logged);
        }
    }
}
