<?php

/**
 * Asserts the release image Apache config PassEnv's the AgentForge ingest
 * vars that mod_php otherwise omits from $_SERVER.
 *
 * @package   OpenEMR
 *
 * @link      https://www.open-emr.org
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Tests\Isolated\Services\Background;

use PHPUnit\Framework\Attributes\Group;
use PHPUnit\Framework\TestCase;

#[Group('isolated')]
#[Group('background-services')]
class AgentForgeIngestApachePassEnvTest extends TestCase
{
    public function testReleaseApacheConfigPassesAgentForgeIngestEnv(): void
    {
        $path = dirname(__DIR__, 5) . '/docker/release/openemr.conf';
        $conf = file_get_contents($path);
        $this->assertIsString($conf, 'docker/release/openemr.conf must be readable');

        preg_match_all('/^PassEnv\s+(.+)$/m', $conf, $matches);
        $passed = [];
        foreach ($matches[1] as $line) {
            foreach (preg_split('/\s+/', trim($line)) ?: [] as $name) {
                if ($name !== '') {
                    $passed[] = $name;
                }
            }
        }

        $this->assertContains('AGENTFORGE_INGEST_URI', $passed);
        $this->assertContains('AGENTFORGE_INGEST_CATEGORY_MAP', $passed);
    }
}
