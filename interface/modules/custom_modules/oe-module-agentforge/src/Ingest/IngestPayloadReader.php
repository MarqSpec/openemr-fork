<?php

/**
 * Reads one document out of OpenEMR (its file bytes and its UUIDs) behind an interface, so IngestForwarder's
 * handling of a document that cannot be read can be tested without OpenEMR's Document class.
 * OpenEmrIngestPayloadReader is the production implementation.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge
 * @copyright Copyright (c) 2026 AgentForge
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\AgentForge\Ingest;

interface IngestPayloadReader
{
    /**
     * @param string $patientUuid the patient's UUID as stored (binary), never empty
     * @throws \RuntimeException|\LogicException when the document cannot be read. OpenEMR's Document throws for a missing or unreadable
     *                    file, a failed decryption and an expired document, and the message can carry the file
     *                    path, so the caller must not log it.
     */
    public function read(IngestDocument $document, string $patientUuid): IngestPayload;
}
