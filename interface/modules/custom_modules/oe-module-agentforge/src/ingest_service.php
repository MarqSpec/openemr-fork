<?php

declare(strict_types=1);

// Background Service entry point for AgentForge document ingestion. OpenEMR's service
// runner require_once's this file and calls agentforge_ingest_new_documents() by name each interval - which
// is why this must be a global function (the runner does function_exists() + $function()), not a class
// method. Registration lives in Bootstrap::registerBackgroundServices(), called from openemr.bootstrap.php.

use GuzzleHttp\Client;
use OpenEMR\BC\ServiceContainer;
use OpenEMR\Modules\AgentForge\Config\AgentForgeGlobalConfig;
use OpenEMR\Modules\AgentForge\Ingest\DocumentIngestService;
use OpenEMR\Modules\AgentForge\Ingest\IngestForwarder;
use OpenEMR\Modules\AgentForge\Ingest\OpenEmrIngestPayloadReader;
use OpenEMR\Modules\AgentForge\Ingest\QueryUtilsIngestDocumentGateway;
use OpenEMR\Modules\AgentForge\Ingest\SidecarIngestClient;

if (!function_exists('agentforge_ingest_new_documents')) {
    /**
     * The scan invoked each interval by the Background Service runner. Kept thin - the work is in
     * DocumentIngestService so it stays unit-reviewable and the entry point is just wiring.
     */
    function agentforge_ingest_new_documents(): void
    {
        // OpenEMR's logger (SystemLogger, through error_log) for the skip, failed-forward and gave-up lines
        $logger = ServiceContainer::getLogger();
        (new DocumentIngestService(
            new AgentForgeGlobalConfig(),
            $logger,
            new QueryUtilsIngestDocumentGateway(new IngestForwarder(
                new OpenEmrIngestPayloadReader(),
                new SidecarIngestClient(new Client(), $logger),
                $logger,
            )),
        ))->run();
    }
}
