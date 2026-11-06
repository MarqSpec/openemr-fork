<?php

/**
 * Forwards one document to the sidecar and says what became of it. Everything that can go wrong before the
 * sidecar is asked - the patient has no UUID, the file cannot be read, is empty, or the document has no UUID of
 * its own - is a typed result rather than an exception, so one bad document never aborts the run (an uncaught
 * throw would stop every document after it, write no state, and put the exception message, which can carry a
 * file path, in OpenEMR's log).
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge
 * @copyright Copyright (c) 2026 AgentForge
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\AgentForge\Ingest;

use Psr\Log\LoggerInterface;

final readonly class IngestForwarder
{
    public function __construct(
        private IngestPayloadReader $reader,
        private SidecarIngestClient $sidecar,
        private LoggerInterface $logger,
    ) {
    }

    public function forward(string $ingestUri, IngestDocument $document): IngestForwardResult
    {
        if ($document->patientUuid === null || $document->patientUuid === '') {
            return IngestForwardResult::NoPatientUuid;
        }

        try {
            $payload = $this->reader->read($document, $document->patientUuid);
        } catch (\RuntimeException | \LogicException $e) {
            // Not \Throwable or \Exception: the fork forbids catches that would swallow an \Error or an
            // \ErrorException (a bug, which must surface). These are the ways OpenEMR's Document fails to read:
            // RuntimeException (missing or unreadable file, failed decryption, the reader's own
            // UnexpectedValueException) and LogicException (BadMethodCallException for an expired document,
            // ramsey's InvalidArgumentException for a malformed uuid). Log the document id and the exception
            // class only: the message can quote the file path, which holds the patient's pid and the file name.
            $this->logger->warning(
                'AgentForge document ingest could not read a document; it is retried on later runs until it is '
                . 'read or given up on',
                ['documentId' => $document->id, 'exceptionClass' => $e::class]
            );
            return IngestForwardResult::Unreadable;
        }

        if ($payload->content === '') {
            return IngestForwardResult::EmptyFile;
        }
        if ($payload->documentReferenceId === '') {
            return IngestForwardResult::NoDocumentUuid;
        }

        // No auth header: the sidecar's /documents/ingest trusts its private-network origin (W2-D17). ingestUri
        // is the sidecar's internal address (agent-forge-api-staging.railway.internal:8080), never public; the
        // reverse proxy does not route this path (the copilot's W2_ARCHITECTURE.md §15 W2-D17).
        // A non-200 or transport failure is logged by SidecarIngestClient.
        $accepted = $this->sidecar->forward($ingestUri, $document->id, [
            ['name' => 'patientId', 'contents' => $payload->patientId],
            ['name' => 'documentReferenceId', 'contents' => $payload->documentReferenceId],
            ['name' => 'docType', 'contents' => $document->docType],
            [
                'name' => 'file',
                'contents' => $payload->content,
                'filename' => $document->fileName,
                'headers' => ['Content-Type' => $document->mediaType],
            ],
        ]);

        return $accepted ? IngestForwardResult::Forwarded : IngestForwardResult::Rejected;
    }
}
