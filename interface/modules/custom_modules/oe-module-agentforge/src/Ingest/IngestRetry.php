<?php

/**
 * Where the ingest run stands on the one document it is holding the watermark back for: which document, in how
 * many runs a failure has counted against it (IngestForwardResult says which failures count), and the highest
 * document id the sidecar has accepted so far - documents at or below it are re-sent only because the watermark
 * is held, so their acceptance is no proof the sidecar is working. Persisted as
 * "<documentId>:<failedRuns>:<acceptedThrough>" in a single global, so it survives across the fresh PHP
 * processes the Background Service starts. It holds three numbers - never a patient identifier or any document
 * content.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge
 * @copyright Copyright (c) 2026 AgentForge
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\AgentForge\Ingest;

final readonly class IngestRetry
{
    public function __construct(public int $documentId, public int $failedRuns, public int $acceptedThrough)
    {
        if ($documentId <= 0 || $failedRuns < 0 || $acceptedThrough < 0) {
            throw new \DomainException('An ingest retry needs a positive document id and non-negative counts');
        }
    }

    /** null for anything that is not "<positive id>:<count>:<id>", so a damaged value restarts the count. */
    public static function fromString(string $stored): ?self
    {
        if (preg_match('/^([1-9][0-9]{0,17}):([0-9]{1,9}):([0-9]{1,18})$/', $stored, $matches) !== 1) {
            return null;
        }

        return new self((int) $matches[1], (int) $matches[2], (int) $matches[3]);
    }

    public function toString(): string
    {
        return $this->documentId . ':' . $this->failedRuns . ':' . $this->acceptedThrough;
    }
}
