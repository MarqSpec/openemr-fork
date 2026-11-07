<?php

/**
 * One document the ingest run is to forward: its id, the docType its category maps to, and what the forward
 * needs from its row. The patient UUID is on it only to be sent to the sidecar; nothing here is ever logged.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge
 * @copyright Copyright (c) 2026 AgentForge
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\AgentForge\Ingest;

final readonly class IngestDocument
{
    public function __construct(
        public int $id,
        public string $docType,
        public string $mediaType,
        public string $fileName,
        public ?string $patientUuid,
    ) {
    }
}
