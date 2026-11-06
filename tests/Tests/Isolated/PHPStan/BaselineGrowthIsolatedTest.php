<?php

/**
 * Isolated test: `.phpstan/baseline-growth.php`, the CI gate that fails a pull request whose
 * PHPStan baseline gains entries.
 *
 * Each case writes a base and a head baseline directory and runs the script on them as CI does.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Adam Marquette
 * @copyright Copyright (c) 2026 Adam Marquette
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Tests\Isolated\PHPStan;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use Symfony\Component\Process\Process;

final class BaselineGrowthIsolatedTest extends TestCase
{
    private const SCRIPT = __DIR__ . '/../../../../.phpstan/baseline-growth.php';

    private string $root;

    protected function setUp(): void
    {
        $this->root = sys_get_temp_dir() . '/baseline-growth-' . bin2hex(random_bytes(6));
        mkdir($this->root . '/base', 0700, true);
        mkdir($this->root . '/head', 0700, true);
    }

    protected function tearDown(): void
    {
        foreach (['base', 'head'] as $side) {
            foreach (glob($this->root . '/' . $side . '/*.php') ?: [] as $file) {
                unlink($file);
            }
            rmdir($this->root . '/' . $side);
        }
        rmdir($this->root);
    }

    /**
     * @param array<string, list<array{string, int, string}>> $base identifier => [message, count, path]
     * @param array<string, list<array{string, int, string}>> $head
     */
    #[DataProvider('baselineProvider')]
    public function testExitStatusFollowsGrowth(array $base, array $head, int $expectedExit, string $expectedOutput): void
    {
        $this->writeBaseline('base', $base);
        $this->writeBaseline('head', $head);

        [$exit, $output] = $this->runScript($this->root . '/base', $this->root . '/head');

        $this->assertSame($expectedExit, $exit, $output);
        $this->assertStringContainsString($expectedOutput, $output);
    }

    /**
     * @return array<string, array{
     *     array<string, list<array{string, int, string}>>,
     *     array<string, list<array{string, int, string}>>,
     *     int,
     *     string
     * }>
     *
     * @codeCoverageIgnore Data providers run before coverage instrumentation starts.
     */
    public static function baselineProvider(): array
    {
        $entry = ['#^Some error\\.$#', 2, 'src/A.php'];
        return [
            'unchanged' => [
                ['argument.type' => [$entry]],
                ['argument.type' => [$entry]],
                0,
                'no new entries',
            ],
            'an entry is fixed' => [
                ['argument.type' => [$entry, ['#^Other\\.$#', 1, 'src/B.php']]],
                ['argument.type' => [$entry]],
                0,
                'no new entries',
            ],
            'a count shrinks' => [
                ['argument.type' => [$entry]],
                ['argument.type' => [['#^Some error\\.$#', 1, 'src/A.php']]],
                0,
                'no new entries',
            ],
            'a new entry' => [
                ['argument.type' => [$entry]],
                ['argument.type' => [$entry, ['#^New error\\.$#', 1, 'src/B.php']]],
                1,
                'argument.type  ../../src/B.php (+1)  #^New error\\.$#',
            ],
            'a count grows' => [
                ['argument.type' => [$entry]],
                ['argument.type' => [['#^Some error\\.$#', 5, 'src/A.php']]],
                1,
                'argument.type  ../../src/A.php (+3)',
            ],
            'a new identifier file' => [
                ['argument.type' => [$entry]],
                ['argument.type' => [$entry], 'method.notFound' => [['#^Nope\\.$#', 1, 'src/C.php']]],
                1,
                'method.notFound  ../../src/C.php (+1)',
            ],
            'the same error moves to another file' => [
                ['argument.type' => [$entry]],
                ['argument.type' => [['#^Some error\\.$#', 2, 'src/Moved.php']]],
                1,
                '../../src/Moved.php (+2)',
            ],
        ];
    }

    public function testRejectsAMissingDirectory(): void
    {
        [$exit, $output] = $this->runScript($this->root . '/base', $this->root . '/absent');

        $this->assertSame(2, $exit);
        $this->assertStringContainsString('Head baseline directory not found', $output);
    }

    public function testTheRepositoryBaselineHasNoGrowthAgainstItself(): void
    {
        $dir = __DIR__ . '/../../../../.phpstan/baseline';

        [$exit, $output] = $this->runScript($dir, $dir);

        $this->assertSame(0, $exit, $output);
    }

    public function testComparesACopyGivenByAnotherPathEqual(): void
    {
        $repoBaseline = __DIR__ . '/../../../../.phpstan/baseline';
        foreach (glob($repoBaseline . '/*.php') ?: [] as $file) {
            copy($file, $this->root . '/head/' . basename($file));
        }

        [$exit, $output] = $this->runScript($repoBaseline, $this->root . '/head');

        $this->assertSame(0, $exit, substr($output, 0, 2000));
    }

    /**
     * @param array<string, list<array{string, int, string}>> $identifiers
     */
    private function writeBaseline(string $side, array $identifiers): void
    {
        foreach ($identifiers as $identifier => $entries) {
            $php = "<?php declare(strict_types = 1);\n\n\$ignoreErrors = [];\n";
            foreach ($entries as [$message, $count, $path]) {
                $php .= sprintf(
                    "\$ignoreErrors[] = [\n    'message' => %s,\n    'count' => %d,\n    'path' => __DIR__ . %s,\n];\n",
                    var_export($message, true),
                    $count,
                    var_export('/../../' . $path, true)
                );
            }
            $php .= "return ['parameters' => ['ignoreErrors' => \$ignoreErrors]];\n";
            file_put_contents($this->root . '/' . $side . '/' . $identifier . '.php', $php);
        }
    }

    /**
     * @return array{int, string} exit status, stdout and stderr together
     */
    private function runScript(string $baseDir, string $headDir): array
    {
        $process = new Process([PHP_BINARY, self::SCRIPT, $baseDir, $headDir]);
        $exit = $process->run();
        return [$exit, $process->getOutput() . $process->getErrorOutput()];
    }
}
