<?php

/**
 * In-memory IngestSettings for the isolated document-ingest tests: holds the raw configured values,
 * the watermark, the retry state and the persisted skip notice, and counts skip-notice and retry writes so a
 * test can assert that a repeated skip or an unchanged retry does not rewrite the global.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge
 * @copyright Copyright (c) 2026 AgentForge
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Tests\Isolated\Modules\AgentForge;

use OpenEMR\Modules\AgentForge\Ingest\IngestRetry;
use OpenEMR\Modules\AgentForge\Ingest\IngestSettings;

final class InMemoryIngestSettings implements IngestSettings
{
    public int $skipNoticeWrites = 0;
    public int $retryWrites = 0;

    public function __construct(
        public ?string $ingestUri = null,
        public ?string $categoryMapSource = null,
        public int $watermark = 0,
        public string $skipNotice = '',
        public ?IngestRetry $retry = null,
    ) {
    }

    public function getIngestUri(): ?string
    {
        return $this->ingestUri;
    }

    public function getIngestCategoryMapSource(): ?string
    {
        return $this->categoryMapSource;
    }

    public function getIngestWatermark(): int
    {
        return $this->watermark;
    }

    public function setIngestWatermark(int $lastDocumentId): void
    {
        $this->watermark = $lastDocumentId;
    }

    public function getIngestRetry(): ?IngestRetry
    {
        return $this->retry;
    }

    public function setIngestRetry(?IngestRetry $retry): void
    {
        $this->retryWrites++;
        $this->retry = $retry;
    }

    public function getIngestSkipNotice(): string
    {
        return $this->skipNotice;
    }

    public function setIngestSkipNotice(string $reason): void
    {
        $this->skipNoticeWrites++;
        $this->skipNotice = $reason;
    }
}
