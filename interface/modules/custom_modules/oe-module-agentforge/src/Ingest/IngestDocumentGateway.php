<?php

/**
 * The two things the ingest run needs from OpenEMR and the sidecar - which documents are new, and forwarding one
 * - behind an interface so the run's watermark and retry decisions can be tested without a database or a
 * sidecar. QueryUtilsIngestDocumentGateway is the production implementation.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge
 * @copyright Copyright (c) 2026 AgentForge
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\AgentForge\Ingest;

interface IngestDocumentGateway
{
    /**
     * The not-deleted patient documents with an id above the watermark whose category is in the map, ascending
     * by id.
     *
     * @param array<array-key, string> $categoryMap document category id => sidecar docType
     * @return list<IngestDocument>
     */
    public function findDocumentsAfter(int $watermark, array $categoryMap): array;

    /**
     * Forwards the document and says what became of it. The sidecar is content-hash idempotent, so forwarding a
     * document again is safe.
     */
    public function forward(string $ingestUri, IngestDocument $document): IngestForwardResult;
}
