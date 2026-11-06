<?php

/**
 * The production IngestPayloadReader: reads the (decrypted) bytes and the DocumentReference id through OpenEMR's
 * Document class and resolves the patient's FHIR id from the stored binary UUID.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge
 * @copyright Copyright (c) 2026 AgentForge
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\AgentForge\Ingest;

use OpenEMR\Common\Uuid\UuidRegistry;

final readonly class OpenEmrIngestPayloadReader implements IngestPayloadReader
{
    public function read(IngestDocument $document, string $patientUuid): IngestPayload
    {
        // The sidecar keys derived facts on the patient's FHIR UUID, not the internal pid - passing a pid
        // makes it read Patient/<pid>, which OpenEMR rejects. Resolved via the patient_data join.
        // As Bootstrap::buildDirectPatientLaunchUrl does.
        $patientId = UuidRegistry::uuidToString($patientUuid);

        // Document::get_data() returns the decrypted bytes and throws an \Exception for a missing or unreadable
        // file (RuntimeException), a failed decryption (RuntimeException) and an expired document
        // (BadMethodCallException). The document's own binary uuid is documented as a string but is null for a
        // row without one; reading the properties as a map keeps the type honest (mixed) so it is narrowed below.
        $file = new \Document($document->id);
        $content = $file->get_data();
        if (!is_string($content)) {
            throw new \UnexpectedValueException('The document has no readable content.');
        }
        $documentUuid = get_object_vars($file)['uuid'] ?? null;
        $documentReferenceId = is_string($documentUuid) && $documentUuid !== ''
            ? UuidRegistry::uuidToString($documentUuid)
            : '';

        return new IngestPayload($patientId, $documentReferenceId, $content);
    }
}
