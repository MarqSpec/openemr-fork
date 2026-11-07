<?php

/**
 * A scripted IngestDocumentGateway for the isolated document-ingest tests: serves a fixed list of
 * documents the way the real query does (ids above the watermark, ascending), answers each forward according
 * to the ids a test marks as rejected by the sidecar or as failing locally, and records every scan and forward
 * so a test can assert exactly what a run touched - including that a skipped run touched nothing. Synthetic
 * data only.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge
 * @copyright Copyright (c) 2026 AgentForge
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Tests\Isolated\Modules\AgentForge;

use OpenEMR\Modules\AgentForge\Ingest\IngestDocument;
use OpenEMR\Modules\AgentForge\Ingest\IngestDocumentGateway;
use OpenEMR\Modules\AgentForge\Ingest\IngestForwarder;
use OpenEMR\Modules\AgentForge\Ingest\IngestForwardResult;

final class FakeIngestDocumentGateway implements IngestDocumentGateway
{
    /** @var list<int> the ids forwarded since the last takeForwarded(), in order */
    private array $forwarded = [];

    /** How many times a run asked for new documents. */
    public int $scans = 0;

    /**
     * @param list<IngestDocument> $documents
     * @param list<int> $failingIds the ids the sidecar rejects; a test changes it between runs
     * @param array<int, IngestForwardResult> $localFailures the ids that fail inside OpenEMR, with the reason
     * @param bool $newestFirst serve the documents in descending id order, which the real query never does, so a
     *                          test can prove the run does not depend on the order it is given
     * @param ?IngestForwarder $forwarder when set, every forward goes through the real forwarder (with a test's
     *                                    reader and sidecar) instead of the scripted answers above
     */
    public function __construct(
        private array $documents,
        public array $failingIds = [],
        public array $localFailures = [],
        public bool $newestFirst = false,
        public ?IngestForwarder $forwarder = null,
    ) {
    }

    public function addDocument(IngestDocument $document): void
    {
        $this->documents[] = $document;
    }

    public function removeDocument(int $id): void
    {
        $this->documents = array_values(array_filter(
            $this->documents,
            static fn (IngestDocument $document): bool => $document->id !== $id
        ));
    }

    public function findDocumentsAfter(int $watermark, array $categoryMap): array
    {
        $this->scans++;
        $found = array_values(array_filter(
            $this->documents,
            static fn (IngestDocument $document): bool => $document->id > $watermark
        ));
        usort($found, fn (IngestDocument $a, IngestDocument $b): int => $this->newestFirst
            ? $b->id <=> $a->id
            : $a->id <=> $b->id);

        return $found;
    }

    public function forward(string $ingestUri, IngestDocument $document): IngestForwardResult
    {
        $this->forwarded[] = $document->id;

        if ($this->forwarder !== null) {
            return $this->forwarder->forward($ingestUri, $document);
        }

        return $this->localFailures[$document->id]
            ?? (in_array($document->id, $this->failingIds, true)
                ? IngestForwardResult::Rejected
                : IngestForwardResult::Forwarded);
    }

    /**
     * @return list<int> the ids forwarded since the last call
     */
    public function takeForwarded(): array
    {
        $forwarded = $this->forwarded;
        $this->forwarded = [];

        return $forwarded;
    }
}
