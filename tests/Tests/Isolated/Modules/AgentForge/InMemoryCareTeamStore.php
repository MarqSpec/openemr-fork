<?php

/**
 * In-memory CareTeamStore for the isolated seeder tests. It mirrors the rows
 * the QueryUtils store writes to `care_teams` / `care_team_member`, so a test
 * can assert exactly what a run added.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge
 * @copyright Copyright (c) 2026 AgentForge
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Tests\Isolated\Modules\AgentForge;

use OpenEMR\Modules\AgentForge\Seed\CareTeamStore;
use OpenEMR\Modules\AgentForge\Seed\DemoCareTeamMember;

final class InMemoryCareTeamStore implements CareTeamStore
{
    /** @var list<array{id: int, pid: int, team_name: string, created_by: int}> */
    public array $teams = [];

    /** @var list<array{care_team_id: int, user_id: int, facility_id: int, role: string, provider_since: ?string, note: string, created_by: int}> */
    public array $members = [];

    public function findCareTeamId(int $pid, string $teamName): ?int
    {
        foreach ($this->teams as $team) {
            if ($team['pid'] === $pid && $team['team_name'] === $teamName) {
                return $team['id'];
            }
        }

        return null;
    }

    public function createCareTeam(int $pid, string $teamName, int $createdBy): int
    {
        $id = count($this->teams) + 1;
        $this->teams[] = ['id' => $id, 'pid' => $pid, 'team_name' => $teamName, 'created_by' => $createdBy];

        return $id;
    }

    public function hasMember(int $careTeamId, int $userId, int $facilityId): bool
    {
        foreach ($this->members as $member) {
            if (
                $member['care_team_id'] === $careTeamId
                && $member['user_id'] === $userId
                && $member['facility_id'] === $facilityId
            ) {
                return true;
            }
        }

        return false;
    }

    public function addMember(int $careTeamId, DemoCareTeamMember $member, int $createdBy): void
    {
        $this->members[] = [
            'care_team_id' => $careTeamId,
            'user_id' => $member->userId,
            'facility_id' => $member->facilityId,
            'role' => $member->role,
            'provider_since' => $member->providerSince?->format('Y-m-d'),
            'note' => $member->note,
            'created_by' => $createdBy,
        ];
    }
}
