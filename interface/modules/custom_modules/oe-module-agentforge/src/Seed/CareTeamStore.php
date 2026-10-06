<?php

/**
 * Persistence port for the demo care-team seeder: the `care_teams` /
 * `care_team_member` rows that CareTeamService (and so FHIR CareTeam) reads.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge
 * @copyright Copyright (c) 2026 AgentForge
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\AgentForge\Seed;

interface CareTeamStore
{
    /** The id of the patient's care team with this exact name, or null when there is none. */
    public function findCareTeamId(int $pid, string $teamName): ?int;

    /** Creates an active care team for the patient and returns its id. */
    public function createCareTeam(int $pid, string $teamName, int $createdBy): int;

    /** Whether the team already has a member row for this practitioner at this facility. */
    public function hasMember(int $careTeamId, int $userId, int $facilityId): bool;

    /** Adds an active member row: the practitioner, and the facility they act for. */
    public function addMember(int $careTeamId, DemoCareTeamMember $member, int $createdBy): void;
}
