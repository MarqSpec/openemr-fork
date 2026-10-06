<?php

/**
 * What one QaSystemClientSeeder::seed() call did.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge
 * @copyright Copyright (c) 2026 AgentForge
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\AgentForge\Seed;

enum QaSystemClientSeedOutcome
{
    /** No client had the declared id (a fresh or reseeded database): it was inserted, enabled. */
    case Created;

    /** The client existed but differed from the declaration (disabled, another key, another scope): it was rewritten. */
    case Converged;

    /** The client already matched the declaration: nothing was written. */
    case AlreadyConverged;
}
