import { AwsClient } from 'aws4fetch';
import {
  PutObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

interface Env {
  R2_BUCKET: R2Bucket;
  DB: D1Database;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  ACCOUNT_ID: string;
  BUCKET_NAME: string;
}

// Response helpers
function responseJSON(data: unknown, statusCode = 200) {
  return new Response(JSON.stringify(data), {
    status: statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

function responseError(error: string, statusCode = 400) {
  return responseJSON({ error, timestamp: new Date().toISOString() }, statusCode);
}

// S3 Client for presigned URLs
function configureS3Client(env: Env) {
  return new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    region: 'auto',
    service: 's3',
    endpointUrl: `https://${env.ACCOUNT_ID}.r2.cloudflarestorage.com`,
  });
}

// ENDPOINT 1: PUT - Upload file to R2
async function handlePut(request: Request, env: Env) {
  const { key, body } = (await request.json()) as {
    key: string;
    body: string;
  };

  if (!key || !body) {
    return responseError('Missing key or body');
  }

  try {
    const buffer = Buffer.from(body, 'base64');
    const result = await env.R2_BUCKET.put(key, buffer, {
      httpMetadata: { contentType: 'application/octet-stream' },
    });

    return responseJSON({
      success: true,
      key: result.key,
      etag: result.etag,
      size: result.size,
      uploadedAt: new Date().toISOString(),
    });
  } catch (err) {
    return responseError(
      `Upload failed: ${err instanceof Error ? err.message : String(err)}`,
      500
    );
  }
}

// ENDPOINT 2: GET - Download file from R2
async function handleGet(request: Request, env: Env) {
  const url = new URL(request.url);
  const key = url.searchParams.get('key');

  if (!key) {
    return responseError('Missing key parameter');
  }

  try {
    const obj = await env.R2_BUCKET.get(key);

    if (!obj) {
      return responseError(`Object not found: ${key}`, 404);
    }

    const body = await obj.arrayBuffer();
    const base64 = Buffer.from(body).toString('base64');

    return responseJSON({
      success: true,
      key: obj.key,
      size: obj.size,
      etag: obj.etag,
      body: base64,
      uploadedAt: obj.uploaded,
    });
  } catch (err) {
    return responseError(
      `Download failed: ${err instanceof Error ? err.message : String(err)}`,
      500
    );
  }
}

// ENDPOINT 3: PRESIGNED_PUT - Generate upload URL
async function handlePresignedPut(request: Request, env: Env) {
  const { key, expiresIn } = (await request.json()) as {
    key: string;
    expiresIn?: number;
  };

  if (!key) {
    return responseError('Missing key');
  }

  try {
    const s3Client = configureS3Client(env);
    const url = await getSignedUrl(
      s3Client as any,
      new PutObjectCommand({
        Bucket: env.BUCKET_NAME,
        Key: key,
      }),
      { expiresIn: expiresIn || 3600 }
    );

    return responseJSON({
      success: true,
      presignedUrl: url,
      key,
      expiresIn: expiresIn || 3600,
      expiresAt: new Date(Date.now() + (expiresIn || 3600) * 1000).toISOString(),
    });
  } catch (err) {
    return responseError(
      `Presigned URL failed: ${err instanceof Error ? err.message : String(err)}`,
      500
    );
  }
}

// ENDPOINT 4: PRESIGNED_GET - Generate download URL
async function handlePresignedGet(request: Request, env: Env) {
  const { key, expiresIn } = (await request.json()) as {
    key: string;
    expiresIn?: number;
  };

  if (!key) {
    return responseError('Missing key');
  }

  try {
    const s3Client = configureS3Client(env);
    const url = await getSignedUrl(
      s3Client as any,
      new GetObjectCommand({
        Bucket: env.BUCKET_NAME,
        Key: key,
      }),
      { expiresIn: expiresIn || 3600 }
    );

    return responseJSON({
      success: true,
      presignedUrl: url,
      key,
      expiresIn: expiresIn || 3600,
      expiresAt: new Date(Date.now() + (expiresIn || 3600) * 1000).toISOString(),
    });
  } catch (err) {
    return responseError(
      `Presigned URL failed: ${err instanceof Error ? err.message : String(err)}`,
      500
    );
  }
}

// ENDPOINT 5: CREATE_AUDIT - Insert audit record to D1
async function handleCreateAudit(request: Request, env: Env) {
  const { document_id, filename, file_size, file_type } = (await request.json()) as {
    document_id: string;
    filename: string;
    file_size?: number;
    file_type?: string;
  };

  if (!document_id || !filename) {
    return responseError('Missing document_id or filename');
  }

  try {
    const { results } = await env.DB.prepare(`
      INSERT INTO document_audits (document_id, filename, file_size, file_type)
      VALUES (?, ?, ?, ?)
      RETURNING id, created_at
    `)
      .bind(document_id, filename, file_size || null, file_type || null)
      .run();

    if (!results?.length) {
      throw new Error('Failed to create audit');
    }

    return responseJSON({
      success: true,
      audit_id: results.id,
      document_id,
      created_at: results.created_at,
      status: 'pending',
    });
  } catch (err) {
    return responseError(
      `Create audit failed: ${err instanceof Error ? err.message : String(err)}`,
      500
    );
  }
}

// ENDPOINT 6: UPDATE_AUDIT_RESULTS - Store audit results to D1
async function handleUpdateAuditResults(request: Request, env: Env) {
  const results = (await request.json()) as Array<{
    document_id: string;
    wcag_id: string;
    status: string;
    severity: string;
    notes: string;
  }>;

  if (!results?.length) {
    return responseError('Missing results array');
  }

  try {
    // Bulk insert results
    for (const result of results) {
      await env.DB.prepare(`
        INSERT OR REPLACE INTO audit_results 
        (document_id, wcag_id, status, issue_severity, remediation_notes)
        VALUES (?, ?, ?, ?, ?)
      `)
        .bind(result.document_id, result.wcag_id, result.status, result.severity, result.notes)
        .run();
    }

    // Update document summary
    const docId = results.document_id;
    await env.DB.prepare(`
      UPDATE document_audits 
      SET 
        audit_status = 'complete',
        total_issues = (SELECT COUNT(*) FROM audit_results WHERE document_id = ?),
        critical_issues = (SELECT COUNT(*) FROM audit_results WHERE document_id = ? AND issue_severity = 'critical'),
        audit_completed_at = CURRENT_TIMESTAMP
      WHERE document_id = ?
    `)
      .bind(docId, docId, docId)
      .run();

    return responseJSON({
      success: true,
      updated: results.length,
      document_id: docId,
    });
  } catch (err) {
    return responseError(
      `Update results failed: ${err instanceof Error ? err.message : String(err)}`,
      500
    );
  }
}

// ROUTER
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    const url = new URL(request.url);
    const path = url.pathname.split('/') || url.searchParams.get('action');

    try {
      switch (path) {
        case 'put':
          return request.method === 'POST' ? handlePut(request, env) : responseError('Method not allowed');
        case 'get':
          return request.method === 'GET' ? handleGet(request, env) : responseError('Method not allowed');
        case 'presigned-put':
          return request.method === 'POST' ? handlePresignedPut(request, env) : responseError('Method not allowed');
        case 'presigned-get':
          return request.method === 'POST' ? handlePresignedGet(request, env) : responseError('Method not allowed');
        case 'create-audit':
          return request.method === 'POST' ? handleCreateAudit(request, env) : responseError('Method not allowed');
        case 'update-audit-results':
          return request.method === 'POST' ? handleUpdateAuditResults(request, env) : responseError('Method not allowed');
        default:
          return responseJSON({
            message: 'A11y Document Remediation API',
            version: '2.0',
            endpoints: [
              'POST /put - Upload to R2',
              'GET /get?key=X - Download from R2',
              'POST /presigned-put - Generate upload URL',
              'POST /presigned-get - Generate download URL',
              'POST /create-audit - Create audit record in D1',
              'POST /update-audit-results - Store audit results in D1',
            ],
          });
      }
    } catch (err) {
      return responseError(
        `Server error: ${err instanceof Error ? err.message : String(err)}`,
        500
      );
    }
  },
};
