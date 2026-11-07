<?php

/**
 * A scripted IngestPayloadReader for the isolated document-ingest tests: returns the payload a test
 * registered for a document id, or throws the exception it registered, the way OpenEMR's Document throws for a
 * missing file, a failed decryption or an expired document. Counts reads so a test can assert that a document
 * was, or was not, read. Synthetic data only.
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
use OpenEMR\Modules\AgentForge\Ingest\IngestPayload;
use OpenEMR\Modules\AgentForge\Ingest\IngestPayloadReader;

final class ScriptedPayloadReader implements IngestPayloadReader
{
    public int $reads = 0;

    /**
     * @param array<int, IngestPayload|\Throwable> $script document id => what reading it yields; an id not
     *                                                      listed throws, as a missing document would
     */
    public function __construct(public array $script = [])
    {
    }

    public function read(IngestDocument $document, string $patientUuid): IngestPayload
    {
        $this->reads++;
        $outcome = $this->script[$document->id] ?? new \RuntimeException('no such document');
        if ($outcome instanceof \Throwable) {
            throw $outcome;
        }

        return $outcome;
    }
}
