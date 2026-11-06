<?php

/**
 * Isolated tests for the AgentForge document-ingest forwarder's logging: a skipped run says which
 * setting is missing or broken - once per distinct reason, not every 2 minutes - and a failed forward names the
 * document id and the status or exception class but no patient identifier and no document content. Runs
 * against in-memory settings, a recording logger and a mocked HTTP client, no database. Synthetic data only.
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
use GuzzleHttp\Exception\ConnectException;
use GuzzleHttp\Handler\MockHandler;
use GuzzleHttp\HandlerStack;
use GuzzleHttp\Psr7\Request;
use GuzzleHttp\Psr7\Response;
use OpenEMR\Modules\AgentForge\Config\AgentForgeGlobalConfig;
use OpenEMR\Modules\AgentForge\Ingest\DocumentIngestService;
use OpenEMR\Modules\AgentForge\Ingest\IngestDocument;
use OpenEMR\Modules\AgentForge\Ingest\SidecarIngestClient;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use Psr\Log\LogLevel;

final class DocumentIngestServiceTest extends TestCase
{
    private const MODULE_SRC = __DIR__ . '/../../../../../interface/modules/custom_modules/oe-module-agentforge/src/';

    private const INGEST_URI = 'http://agent-forge-api.test.internal:8080/documents/ingest';
    private const VALID_MAP = '{"12":"lab_pdf","15":"intake_form"}';

    // Synthetic stand-ins for what a real forward carries; none of them may reach a log line.
    private const DOCUMENT_ID = 4711;
    private const PATIENT_ID = 'a1b2c3d4-0000-4000-8000-00000000af01';
    private const DOCUMENT_REFERENCE_ID = 'f0e1d2c3-0000-4000-8000-00000000af02';
    private const FILENAME = 'af-demo-synthetic-lab.pdf';
    private const CONTENT = '%PDF-1.4 SYNTHETIC AF-DEMO LAB REPORT BYTES';

    private RecordingLogger $logger;
    private FakeIngestDocumentGateway $gateway;

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
                'Ingest/IngestSkipReason',
                'Ingest/SidecarIngestClient',
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
        // One document that would be forwarded if a skipped run scanned anyway - the tripwire for the skip tests.
        $this->gateway = new FakeIngestDocumentGateway([
            new IngestDocument(self::DOCUMENT_ID, 'lab_pdf', 'application/pdf', self::FILENAME, self::PATIENT_ID),
        ]);
    }

    public function testUnsetIngestUriSkipsWithOneWarningNamingTheSetting(): void
    {
        $settings = new InMemoryIngestSettings(ingestUri: null, categoryMapSource: self::VALID_MAP);

        $this->service($settings)->run();
        $this->assertNothingScanned();

        $warnings = $this->logger->warnings();
        self::assertCount(1, $warnings);
        self::assertCount(1, $this->logger->records);
        self::assertStringContainsString('AGENTFORGE_INGEST_URI', $warnings[0]['message']);
        self::assertStringContainsString('agentforge_ingest_uri', $warnings[0]['message']);
        self::assertSame(['reason' => 'ingest_uri_unset'], $warnings[0]['context']);
        self::assertSame(0, $settings->watermark);
    }

    #[DataProvider('unusableCategoryMaps')]
    public function testUnusableCategoryMapSkipsWithOneWarningNamingTheSetting(?string $source, string $reason): void
    {
        $settings = new InMemoryIngestSettings(ingestUri: self::INGEST_URI, categoryMapSource: $source);

        $this->service($settings)->run();
        $this->assertNothingScanned();

        $warnings = $this->logger->warnings();
        self::assertCount(1, $warnings);
        self::assertCount(1, $this->logger->records);
        self::assertStringContainsString('AGENTFORGE_INGEST_CATEGORY_MAP', $warnings[0]['message']);
        self::assertStringContainsString('agentforge_ingest_category_map', $warnings[0]['message']);
        self::assertSame(['reason' => $reason], $warnings[0]['context']);
        self::assertSame(0, $settings->watermark);
    }

    /**
     * @return array<string, array{?string, string}>
     *
     * @codeCoverageIgnore Data providers run before coverage instrumentation starts.
     */
    public static function unusableCategoryMaps(): array
    {
        return [
            'unset' => [null, 'category_map_unset'],
            'not JSON' => ['{"12":"lab_pdf"', 'category_map_unparseable'],
            'JSON but not an object' => ['"lab_pdf"', 'category_map_unparseable'],
            'empty object' => ['{}', 'category_map_no_valid_entries'],
            'only unrecognised docTypes' => ['{"12":"x_ray","15":7}', 'category_map_no_valid_entries'],
        ];
    }

    public function testAnUnsetCategoryMapIsReportedDifferentlyFromOneSetButUnusable(): void
    {
        $messages = [];
        foreach ([null, 'not json', '{}'] as $source) {
            $logger = new RecordingLogger();
            $settings = new InMemoryIngestSettings(ingestUri: self::INGEST_URI, categoryMapSource: $source);
            $this->service($settings, $logger)->run();
            $messages[] = $logger->warnings()[0]['message'];
        }
        $this->assertNothingScanned();

        self::assertCount(3, array_unique($messages));
        self::assertStringContainsString('no category map is configured', $messages[0]);
        self::assertStringContainsString('is set but', $messages[1]);
        self::assertStringContainsString('is set but', $messages[2]);
    }

    public function testARepeatedSkipWarnsOnceThenDropsToDebug(): void
    {
        $settings = new InMemoryIngestSettings(ingestUri: null, categoryMapSource: null);
        $service = $this->service($settings);

        $service->run();
        $service->run();
        $service->run();
        $this->assertNothingScanned();

        self::assertCount(1, $this->logger->warnings());
        self::assertCount(2, $this->logger->atLevel(LogLevel::DEBUG));
        self::assertSame([], $this->logger->atLevel(LogLevel::ERROR));
        self::assertSame(1, $settings->skipNoticeWrites);
        self::assertSame('ingest_uri_unset', $settings->skipNotice);
    }

    public function testASkipNoticeSurvivesAcrossProcessesThroughTheSettings(): void
    {
        // Each Background Service run is a fresh PHP process: the de-duplication must come from the persisted
        // notice, not from anything held in memory.
        $settings = new InMemoryIngestSettings(ingestUri: null, skipNotice: 'ingest_uri_unset');

        $this->service($settings)->run();
        $this->assertNothingScanned();

        self::assertSame([], $this->logger->warnings());
        self::assertCount(1, $this->logger->atLevel(LogLevel::DEBUG));
        self::assertSame(0, $settings->skipNoticeWrites);
    }

    public function testADifferentSkipReasonWarnsAgain(): void
    {
        $settings = new InMemoryIngestSettings(ingestUri: null, categoryMapSource: self::VALID_MAP);
        $service = $this->service($settings);
        $service->run();

        // The URI is fixed but the map is broken: that is news, so it warns.
        $settings->ingestUri = self::INGEST_URI;
        $settings->categoryMapSource = 'not json';
        $service->run();
        $this->assertNothingScanned();

        $warnings = $this->logger->warnings();
        self::assertCount(2, $warnings);
        self::assertSame(['reason' => 'category_map_unparseable'], $warnings[1]['context']);
        self::assertSame('category_map_unparseable', $settings->skipNotice);
    }

    public function testParseIngestCategoryMapDistinguishesUnparseableFromEmpty(): void
    {
        self::assertNull(AgentForgeGlobalConfig::parseIngestCategoryMap('not json'));
        self::assertNull(AgentForgeGlobalConfig::parseIngestCategoryMap('42'));
        self::assertSame([], AgentForgeGlobalConfig::parseIngestCategoryMap('{}'));
        self::assertSame([], AgentForgeGlobalConfig::parseIngestCategoryMap('{"12":"x_ray"}'));
        self::assertSame(
            [12 => 'lab_pdf', 15 => 'intake_form'],
            AgentForgeGlobalConfig::parseIngestCategoryMap('{"12":"lab_pdf","15":"intake_form","16":"x_ray"}')
        );
    }

    public function testANon200ForwardLogsTheDocumentIdAndStatusAndNoPatientData(): void
    {
        $client = $this->sidecar(new MockHandler([new Response(503, [], 'upstream ' . self::PATIENT_ID)]));

        self::assertFalse($client->forward(self::INGEST_URI, self::DOCUMENT_ID, $this->multipart()));

        $warnings = $this->logger->warnings();
        self::assertCount(1, $warnings);
        self::assertSame(['documentId' => self::DOCUMENT_ID, 'status' => 503], $warnings[0]['context']);
        $this->assertNoPatientDataLogged();
    }

    public function testATransportFailureLogsTheDocumentIdAndExceptionClassAndNoPatientData(): void
    {
        $request = new Request('POST', self::INGEST_URI);
        // A message quoting the request is exactly what must not reach the log.
        $exception = new ConnectException('cURL error 6 for patientId=' . self::PATIENT_ID, $request);
        $client = $this->sidecar(new MockHandler([$exception]));

        self::assertFalse($client->forward(self::INGEST_URI, self::DOCUMENT_ID, $this->multipart()));

        $warnings = $this->logger->warnings();
        self::assertCount(1, $warnings);
        self::assertSame(
            ['documentId' => self::DOCUMENT_ID, 'exceptionClass' => ConnectException::class],
            $warnings[0]['context']
        );
        $this->assertNoPatientDataLogged();
    }

    public function testAnAcceptedForwardLogsNothing(): void
    {
        $client = $this->sidecar(new MockHandler([new Response(200)]));

        self::assertTrue($client->forward(self::INGEST_URI, self::DOCUMENT_ID, $this->multipart()));
        self::assertSame([], $this->logger->records);
    }

    private function service(InMemoryIngestSettings $settings, ?RecordingLogger $logger = null): DocumentIngestService
    {
        $logger ??= $this->logger;
        // A skipped run must never reach the gateway; each skip test asserts that with assertNothingScanned().
        return new DocumentIngestService($settings, $logger, $this->gateway);
    }

    private function assertNothingScanned(): void
    {
        self::assertSame(0, $this->gateway->scans, 'a skipped run must not look for documents');
        self::assertSame([], $this->gateway->takeForwarded(), 'a skipped run must not forward anything');
    }

    private function sidecar(MockHandler $handler): SidecarIngestClient
    {
        return new SidecarIngestClient(new Client(['handler' => HandlerStack::create($handler)]), $this->logger);
    }

    /**
     * @return list<array<string, mixed>>
     */
    private function multipart(): array
    {
        return [
            ['name' => 'patientId', 'contents' => self::PATIENT_ID],
            ['name' => 'documentReferenceId', 'contents' => self::DOCUMENT_REFERENCE_ID],
            ['name' => 'docType', 'contents' => 'lab_pdf'],
            [
                'name' => 'file',
                'contents' => self::CONTENT,
                'filename' => self::FILENAME,
                'headers' => ['Content-Type' => 'application/pdf'],
            ],
        ];
    }

    private function assertNoPatientDataLogged(): void
    {
        $logged = var_export($this->logger->records, true);
        foreach ([self::PATIENT_ID, self::DOCUMENT_REFERENCE_ID, self::FILENAME, self::CONTENT] as $forbidden) {
            self::assertStringNotContainsString($forbidden, $logged);
        }
    }
}
