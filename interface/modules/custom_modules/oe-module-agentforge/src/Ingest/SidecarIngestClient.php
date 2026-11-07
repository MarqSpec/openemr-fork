<?php

/**
 * POSTs one document to the AgentForge sidecar's /documents/ingest and logs a failed forward. The log line
 * carries the document id and the HTTP status or the exception class only - never the patient id, the file
 * name or the content, and never the exception message (a Guzzle message can quote the request or response).
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge
 * @copyright Copyright (c) 2026 AgentForge
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\AgentForge\Ingest;

use GuzzleHttp\ClientInterface;
use GuzzleHttp\Exception\GuzzleException;
use Psr\Log\LoggerInterface;

final readonly class SidecarIngestClient
{
    private const FAILED_MESSAGE = 'AgentForge document ingest forward failed; '
        . 'it is retried on later runs until it is accepted or given up on';

    public function __construct(private ClientInterface $http, private LoggerInterface $logger)
    {
    }

    /**
     * @param list<array<string, mixed>> $multipart the Guzzle multipart parts for the ingest request
     * @return bool true when the sidecar accepted the document (200 = ingested or already on file)
     */
    public function forward(string $ingestUri, int $documentId, array $multipart): bool
    {
        // http_errors off + catch: a non-200 or transport failure is logged and reported as not accepted, never
        // aborts the whole scan. The caller holds its watermark below a document that was not accepted, so it is
        // retried on later runs until it is accepted or the caller gives up on it and logs that (see
        // DocumentIngestService::run); the sidecar is content-hash idempotent, so a retry is safe.
        try {
            $response = $this->http->request('POST', $ingestUri, [
                'multipart' => $multipart,
                'timeout' => 120,
                'http_errors' => false,
            ]);
        } catch (GuzzleException $e) {
            $this->logger->warning(self::FAILED_MESSAGE, [
                'documentId' => $documentId,
                'exceptionClass' => $e::class,
            ]);
            return false;
        }

        $status = $response->getStatusCode();
        if ($status === 200) {
            return true;
        }

        $this->logger->warning(self::FAILED_MESSAGE, [
            'documentId' => $documentId,
            'status' => $status,
        ]);
        return false;
    }
}
