<?php

/**
 * Background Service that forwards newly uploaded patient documents to the AgentForge sidecar.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge
 * @copyright Copyright (c) 2026 AgentForge
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\AgentForge\Ingest;

use OpenEMR\Modules\AgentForge\Config\AgentForgeGlobalConfig;
use Psr\Log\LoggerInterface;

/**
 * Forwards newly-uploaded patient documents to the AgentForge sidecar for extraction. Runs as an OpenEMR
 * Background Service (cron), pre-visit, so the clinician's copilot only reads ready facts. The front desk
 * uploads through OpenEMR's own Documents workflow; this scan is the trigger (OpenEMR has no
 * document-created event to subscribe to).
 *
 * DRAFT - not yet exercised against a running OpenEMR. Points needing verification are marked "VERIFY:".
 */
final readonly class DocumentIngestService
{
    /**
     * How many runs may count against one failed document before the run gives up on it and moves the
     * watermark past it. At the 2-minute Background Service interval that is about an hour of retries; a document
     * that still fails then is not a transient outage, and holding the watermark for it would re-send every later
     * document on every run indefinitely.
     */
    public const MAX_FAILED_RUNS = 30;

    public function __construct(
        private IngestSettings $config,
        private LoggerInterface $logger,
        private IngestDocumentGateway $documents,
    ) {
    }

    /**
     * Scans documents above the watermark whose category is mapped to a docType, forwards each to the
     * sidecar, and advances the watermark. Fails closed: with no ingest URI or no usable category map, it
     * forwards nothing - and says why in the log, once per distinct reason.
     *
     * Retries: the watermark never moves past a document whose forward failed. It stops one id below
     * the lowest failed document, so the next run scans that document again - along with every later document,
     * which is forwarded again and is harmless because the sidecar is content-hash idempotent. A failed run
     * counts against that document by why it failed (IngestForwardResult). A sidecar rejection counts only if the
     * sidecar newly accepted another document in the run - one above every id it had accepted before, since a 200
     * for a document merely re-sent proves nothing - so a sidecar outage counts against no one. A file that could
     * not be read counts only if another file was read in the run, so a storage outage counts against no one
     * either. A missing patient UUID, an empty file and a missing document UUID are facts about the document and
     * count every run. After MAX_FAILED_RUNS counted runs it is given up on, so it cannot hold the watermark
     * back forever: an error line names its id and the reason, and re-uploading it after fixing the cause is the
     * remedy. Until then it is held and retried, because the cause can clear on its own (a patient's UUID gets
     * generated, a storage hiccup passes) - at the price of re-sending every later document on each run.
     */
    public function run(): void
    {
        $ingestUri = $this->config->getIngestUri();
        if ($ingestUri === null) {
            $this->reportSkip(IngestSkipReason::IngestUriUnset);
            return;
        }

        $categoryMapSource = $this->config->getIngestCategoryMapSource();
        if ($categoryMapSource === null) {
            $this->reportSkip(IngestSkipReason::CategoryMapUnset);
            return;
        }

        $categoryMap = AgentForgeGlobalConfig::parseIngestCategoryMap($categoryMapSource);
        if ($categoryMap === null) {
            $this->reportSkip(IngestSkipReason::CategoryMapUnparseable);
            return;
        }
        if ($categoryMap === []) {
            $this->reportSkip(IngestSkipReason::CategoryMapHasNoValidEntries);
            return;
        }

        // Configured again: forget the last skip, so a later relapse warns afresh.
        if ($this->config->getIngestSkipNotice() !== '') {
            $this->config->setIngestSkipNotice('');
        }

        $watermark = $this->config->getIngestWatermark();
        $previousRetry = $this->config->getIngestRetry();

        // Documents at or below this were already accepted in an earlier run and are only re-sent because the
        // watermark is held below a failure; the sidecar's 200 for them is not evidence it is working.
        $alreadyAccepted = max($watermark, $previousRetry->acceptedThrough ?? 0);
        $acceptedThrough = $alreadyAccepted;
        $highestId = $watermark;
        $newlyAccepted = 0;
        $filesRead = 0;
        $failures = [];
        foreach ($this->documents->findDocumentsAfter($watermark, $categoryMap) as $document) {
            $highestId = max($highestId, $document->id);
            $result = $this->documents->forward($ingestUri, $document);
            if ($result->fileWasRead()) {
                $filesRead++;
            }
            if ($result === IngestForwardResult::Forwarded) {
                if ($document->id > $alreadyAccepted) {
                    $newlyAccepted++;
                }
                $acceptedThrough = max($acceptedThrough, $document->id);
            } else {
                $failures[$document->id] ??= $result;
            }
        }
        ksort($failures);

        // The first failure is the lowest. The loop gives up on the lowest while it is over the limit and then
        // judges the next one, which has no history of its own yet.
        $failedRuns = 0;
        $priorRetry = $previousRetry;
        $lowest = array_key_first($failures);
        while ($lowest !== null) {
            $result = $failures[$lowest];
            $failedRuns = $priorRetry !== null && $priorRetry->documentId === $lowest ? $priorRetry->failedRuns : 0;
            if ($result->countsAgainstDocument($newlyAccepted > 0, $filesRead > 0)) {
                $failedRuns++;
            }
            if ($failedRuns < self::MAX_FAILED_RUNS) {
                break;
            }

            $this->logger->error($result->giveUpMessage(), [
                'documentId' => $lowest,
                'failedRuns' => $failedRuns,
                'reason' => $result->value,
            ]);
            unset($failures[$lowest]);
            $priorRetry = null;
            $lowest = array_key_first($failures);
        }

        if ($lowest === null) {
            $newWatermark = $highestId;
            $retry = null;
        } else {
            $newWatermark = $lowest - 1;
            $retry = new IngestRetry($lowest, $failedRuns, max($acceptedThrough, $newWatermark));
        }

        if ($newWatermark > $watermark) {
            $this->config->setIngestWatermark($newWatermark);
        }
        if ($retry?->toString() !== $previousRetry?->toString()) {
            $this->config->setIngestRetry($retry);
        }
    }

    /**
     * Warns once per distinct reason: a permanently unconfigured install would otherwise warn every run (every
     * 2 minutes). Repeats go to debug, which SystemLogger drops unless debug logging is on.
     */
    private function reportSkip(IngestSkipReason $reason): void
    {
        $context = ['reason' => $reason->value];
        if ($this->config->getIngestSkipNotice() === $reason->value) {
            $this->logger->debug($reason->message(), $context);
            return;
        }

        $this->logger->warning($reason->message(), $context);
        $this->config->setIngestSkipNotice($reason->value);
    }
}
