<?php

/**
 * CareTeamStore over the `care_teams` / `care_team_member` tables — the rows
 * CareTeamService::search() joins and FhirCareTeamService serves as FHIR
 * CareTeam. Column semantics follow CareTeamService::saveCareTeam(): the team
 * carries a registry uuid, both rows are `active`, and a member row with
 * user_id + facility_id becomes a Practitioner participant (onBehalfOf the
 * Organization) plus an Organization participant.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge
 * @copyright Copyright (c) 2026 AgentForge
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\AgentForge\Seed;

use OpenEMR\Common\Database\QueryUtils;
use OpenEMR\Common\Uuid\UuidRegistry;

final class QueryUtilsCareTeamStore implements CareTeamStore
{
    private const STATUS_ACTIVE = 'active';

    public function findCareTeamId(int $pid, string $teamName): ?int
    {
        $row = QueryUtils::querySingleRow(
            "SELECT id FROM care_teams WHERE pid = ? AND team_name = ? ORDER BY id LIMIT 1",
            [$pid, $teamName]
        );
        $id = self::intColumn($row, 'id');

        return $id > 0 ? $id : null;
    }

    public function createCareTeam(int $pid, string $teamName, int $createdBy): int
    {
        $uuid = UuidRegistry::getRegistryForTable('care_teams')->createUuid();

        return QueryUtils::sqlInsert(
            "INSERT INTO care_teams (uuid, pid, team_name, status, created_by, date_created)
             VALUES (?, ?, ?, ?, ?, NOW())",
            [$uuid, $pid, $teamName, self::STATUS_ACTIVE, $createdBy]
        );
    }

    public function hasMember(int $careTeamId, int $userId, int $facilityId): bool
    {
        $row = QueryUtils::querySingleRow(
            "SELECT id FROM care_team_member WHERE care_team_id = ? AND user_id = ? AND facility_id = ? LIMIT 1",
            [$careTeamId, $userId, $facilityId]
        );

        return self::intColumn($row, 'id') > 0;
    }

    public function addMember(int $careTeamId, DemoCareTeamMember $member, int $createdBy): void
    {
        QueryUtils::sqlInsert(
            "INSERT INTO care_team_member
                (care_team_id, user_id, contact_id, role, facility_id, provider_since, status, note, created_by, date_created)
             VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, NOW())",
            [
                $careTeamId,
                $member->userId,
                $member->role,
                $member->facilityId,
                $member->providerSince?->format('Y-m-d'),
                self::STATUS_ACTIVE,
                $member->note,
                $createdBy,
            ]
        );
    }

    /** Narrows a single-row query result to a positive int column, 0 when absent. */
    private static function intColumn(mixed $row, string $key): int
    {
        if (!is_array($row) || !isset($row[$key])) {
            return 0;
        }
        $value = $row[$key];
        if (is_int($value)) {
            return $value;
        }

        return is_string($value) && ctype_digit($value) ? (int) $value : 0;
    }
}
