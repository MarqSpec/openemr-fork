<?php

/**
 * One synthetic care-team member for the demo cohort: a practitioner (users.id)
 * acting for a facility (facility.id). One such row yields both a Practitioner
 * and an Organization participant on the FHIR CareTeam.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge
 * @copyright Copyright (c) 2026 AgentForge
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\AgentForge\Seed;

use DateTimeImmutable;

final readonly class DemoCareTeamMember
{
    /**
     * @param int $userId practitioner, fk users.id
     * @param int $facilityId organization, fk facility.id
     * @param string $role list_options.option_id in list `care_team_roles`
     * @param ?DateTimeImmutable $providerSince start of the practitioner's involvement, if known
     */
    public function __construct(
        public int $userId,
        public int $facilityId,
        public string $role,
        public ?DateTimeImmutable $providerSince,
        public string $note,
    ) {
        if ($userId <= 0) {
            throw new \DomainException('Care-team practitioner id must be positive');
        }
        if ($facilityId <= 0) {
            throw new \DomainException('Care-team facility id must be positive');
        }
        if (trim($role) === '') {
            throw new \DomainException('Care-team role must not be blank');
        }
    }
}
