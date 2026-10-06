<?php

/**
 * Gives a demo patient the AgentForge demo care team, idempotently.
 *
 * The team is keyed on (patient, TEAM_NAME) and its member on (team,
 * practitioner, facility), so a re-run finds both and writes nothing, and an
 * interrupted run is completed rather than duplicated. Any other care team on
 * the patient is left untouched.
 *
 * SYNTHETIC / DEMO DATA ONLY.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge
 * @copyright Copyright (c) 2026 AgentForge
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\AgentForge\Seed;

final readonly class DemoCareTeamSeeder
{
    public const TEAM_NAME = 'AgentForge Demo Cardiology Team';

    public function __construct(private CareTeamStore $store)
    {
    }

    /**
     * @param int $pid patient_data.pid of a demo patient
     * @param int $createdBy users.id the rows are attributed to
     */
    public function seedPatient(int $pid, DemoCareTeamMember $member, int $createdBy): CareTeamSeedOutcome
    {
        if ($pid <= 0) {
            throw new \DomainException('Patient id must be positive');
        }

        $teamId = $this->store->findCareTeamId($pid, self::TEAM_NAME);
        if ($teamId === null) {
            $teamId = $this->store->createCareTeam($pid, self::TEAM_NAME, $createdBy);
            $this->store->addMember($teamId, $member, $createdBy);
            return CareTeamSeedOutcome::TeamCreated;
        }

        if ($this->store->hasMember($teamId, $member->userId, $member->facilityId)) {
            return CareTeamSeedOutcome::AlreadySeeded;
        }

        $this->store->addMember($teamId, $member, $createdBy);
        return CareTeamSeedOutcome::MemberAdded;
    }
}
