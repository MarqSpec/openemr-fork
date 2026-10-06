<?php

/**
 * What one DemoCareTeamSeeder::seedPatient() call did to a patient.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge
 * @copyright Copyright (c) 2026 AgentForge
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\AgentForge\Seed;

enum CareTeamSeedOutcome
{
    /** The demo team did not exist: it was created with its member. */
    case TeamCreated;

    /** The demo team existed without the member (an interrupted run): only the member was added. */
    case MemberAdded;

    /** The demo team and its member were already there: nothing was written. */
    case AlreadySeeded;
}
