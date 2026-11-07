<?php

/**
 * The settings the document-ingest run reads and writes, so the run's skip and logging decisions can be tested
 * without a database. AgentForgeGlobalConfig is the production implementation.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge
 * @copyright Copyright (c) 2026 AgentForge
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\AgentForge\Ingest;

interface IngestSettings
{
    public function getIngestUri(): ?string;

    /** The category map as configured, before parsing; null when neither the global nor the env var is set. */
    public function getIngestCategoryMapSource(): ?string;

    /** Every document with an id at or below this has been forwarded, or was given up on. */
    public function getIngestWatermark(): int;

    public function setIngestWatermark(int $lastDocumentId): void;

    /** The document holding the watermark back and its rejected-run count; null when nothing is held back. */
    public function getIngestRetry(): ?IngestRetry;

    public function setIngestRetry(?IngestRetry $retry): void;

    /** The skip reason last logged at warning level ('' when the last run was not skipped). */
    public function getIngestSkipNotice(): string;

    public function setIngestSkipNotice(string $reason): void;
}
