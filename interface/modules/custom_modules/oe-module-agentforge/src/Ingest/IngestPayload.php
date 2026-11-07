<?php

/**
 * What the sidecar's ingest endpoint needs for one document, read from OpenEMR: the patient's FHIR id, the
 * document's own FHIR DocumentReference id and the file bytes. It is PHI and is only ever handed to the
 * sidecar - nothing here is logged.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge
 * @copyright Copyright (c) 2026 AgentForge
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\AgentForge\Ingest;

final readonly class IngestPayload
{
    public function __construct(
        public string $patientId,
        public string $documentReferenceId,
        public string $content,
    ) {
    }
}
