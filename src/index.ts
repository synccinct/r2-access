
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

interface Env {
  R2_BUCKET: R2Bucket;
  DB: D1Database;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
}

interface AuditRequest {
  document_id: string;
  filename: string;
  file_size: number;
  file_type?: string;
}

interface PresignedRequest {
  key: string;
  expiresIn: number;
}

interface UpdateAuditRequest {
  audit_id: number;
  wcag_requirements: Array<{
    wcag_id: string;
    status: string;
    severity: string;
    notes: string;
  }>;
}

// Initialize S3 client for R2
function getS3Client(env: Env): S3Client {
  return new S3Client({
    region: 'auto',
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    },
  });
}

// Endpoint 1: Create Audit Record in D1
async function createAudit(req: AuditRequest, env: Env): Promise<Response> {
  try {
    const { document_id, filename, file_size, file_type } = req;

    const stmt = env.DB.prepare(
      `INSERT INTO document_audits (document_id, filename, file_size, file_type, audit_status, created_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))
       RETURNING id, created_at`
    );

    const result = await stmt.bind(document_id, filename, file_size, file_type || 'application/pdf').first();

    if (!result) {
      throw new Error('Failed to create audit record');
    }

    const typedResult = result as Record<string, unknown>;

    return new Response(
      JSON.stringify({
        success: true,
        audit_id: typedResult.id,
        document_id,
        status: 'pending',
        created_at: typedResult.created_at,
      }),
      { headers: { 'Content-Type': 'application/json' }, status: 200 }
    );
  } catch (error) {
    console.error('Create audit error:', error);
    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }),
      { headers: { 'Content-Type': 'application/json' }, status: 500 }
    );
  }
}

// Endpoint 2: Upload File to R2 (presigned)
async function generatePresignedPut(req: PresignedRequest, env: Env): Promise<Response> {
  try {
    const { key, expiresIn } = req;
    const client = getS3Client(env);

    const command = new PutObjectCommand({
      Bucket: 'a11y-docs-input',
      Key: key,
    });

    const presignedUrl = await getSignedUrl(client, command, { expiresIn });

    const expiresAt = new Date(Date.now() + expiresIn * 1000);

    return new Response(
      JSON.stringify({
        success: true,
        presignedUrl,
        expiresIn,
        expiresAt: expiresAt.toISOString(),
      }),
      { headers: { 'Content-Type': 'application/json' }, status: 200 }
    );
  } catch (error) {
    console.error('Presigned PUT error:', error);
    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }),
      { headers: { 'Content-Type': 'application/json' }, status: 500 }
    );
  }
}

// Endpoint 3: Download File from R2 (presigned)
async function generatePresignedGet(req: PresignedRequest, env: Env): Promise<Response> {
  try {
    const { key, expiresIn } = req;
    const client = getS3Client(env);

    const command = new GetObjectCommand({
      Bucket: 'a11y-docs-input',
      Key: key,
    });

    const presignedUrl = await getSignedUrl(client, command, { expiresIn });

    const expiresAt = new Date(Date.now() + expiresIn * 1000);

    return new Response(
      JSON.stringify({
        success: true,
        presignedUrl,
        expiresIn,
        expiresAt: expiresAt.toISOString(),
      }),
      { headers: { 'Content-Type': 'application/json' }, status: 200 }
    );
  } catch (error) {
    console.error('Presigned GET error:', error);
    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }),
      { headers: { 'Content-Type': 'application/json' }, status: 500 }
    );
  }
}

// Endpoint 4: Update Audit Results in D1
async function updateAuditResults(req: UpdateAuditRequest, env: Env): Promise<Response> {
  try {
    const { audit_id, wcag_requirements } = req;

    // Update audit status to "in-progress"
    const updateAuditStmt = env.DB.prepare(
      `UPDATE document_audits SET audit_status = ? WHERE id = ?`
    );

    await updateAuditStmt.bind('in-progress', audit_id).run();

    // Insert WCAG requirements
    const insertReqStmt = env.DB.prepare(
      `INSERT INTO audit_findings (audit_id, wcag_id, status, severity, notes)
       VALUES (?, ?, ?, ?, ?)`
    );

    for (const requirement of wcag_requirements) {
      await insertReqStmt
        .bind(audit_id, requirement.wcag_id, requirement.status, requirement.severity, requirement.notes)
        .run();
    }

    return new Response(
      JSON.stringify({
        success: true,
        audit_id,
        findings_count: wcag_requirements.length,
        status: 'in-progress',
      }),
      { headers: { 'Content-Type': 'application/json' }, status: 200 }
    );
  } catch (error) {
    console.error('Update audit error:', error);
    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }),
      { headers: { 'Content-Type': 'application/json' }, status: 500 }
    );
  }
}

// Endpoint 5: Get Audit Status
async function getAuditStatus(auditId: number, env: Env): Promise<Response> {
  try {
    const stmt = env.DB.prepare(
      `SELECT id, document_id, filename, audit_status, created_at
       FROM document_audits WHERE id = ?`
    );

    const audit = await stmt.bind(auditId).first();

    if (!audit) {
      return new Response(
        JSON.stringify({ success: false, error: 'Audit not found' }),
        { headers: { 'Content-Type': 'application/json' }, status: 404 }
      );
    }

    const findingsStmt = env.DB.prepare(
      `SELECT wcag_id, status, severity, notes FROM audit_findings WHERE audit_id = ?`
    );

    const findings = await findingsStmt.bind(auditId).all();

    return new Response(
      JSON.stringify({
        success: true,
        audit,
        findings: findings.results || [],
      }),
      { headers: { 'Content-Type': 'application/json' }, status: 200 }
    );
  } catch (error) {
    console.error('Get status error:', error);
    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }),
      { headers: { 'Content-Type': 'application/json' }, status: 500 }
    );
  }
}

// Endpoint 6: Health Check
async function healthCheck(): Promise<Response> {
  return new Response(
    JSON.stringify({
      success: true,
      status: 'healthy',
      timestamp: new Date().toISOString(),
      endpoints: {
        'POST /create-audit': 'Create new audit record',
        'POST /presigned-put': 'Get presigned URL for upload',
        'POST /presigned-get': 'Get presigned URL for download',
        'POST /update-audit': 'Update audit results',
        'GET /audit/:id': 'Get audit status',
        'GET /health': 'Health check',
      },
    }),
    { headers: { 'Content-Type': 'application/json' }, status: 200 }
  );
}

// Main router
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname, searchParams } = new URL(request.url);
    const method = request.method;

    // CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    // Handle CORS preflight
    if (method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // POST /create-audit
      if (pathname === '/create-audit' && method === 'POST') {
        const body = await request.json() as AuditRequest;
        const response = await createAudit(body, env);
        return new Response(response.body, {
          status: response.status,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // POST /presigned-put
      if (pathname === '/presigned-put' && method === 'POST') {
        const body = await request.json() as PresignedRequest;
        const response = await generatePresignedPut(body, env);
        return new Response(response.body, {
          status: response.status,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // POST /presigned-get
      if (pathname === '/presigned-get' && method === 'POST') {
        const body = await request.json() as PresignedRequest;
        const response = await generatePresignedGet(body, env);
        return new Response(response.body, {
          status: response.status,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // POST /update-audit
      if (pathname === '/update-audit' && method === 'POST') {
        const body = await request.json() as UpdateAuditRequest;
        const response = await updateAuditResults(body, env);
        return new Response(response.body, {
          status: response.status,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // GET /audit/:id
      if (pathname.startsWith('/audit/') && method === 'GET') {
        const auditId = parseInt(pathname.split('/')[2], 10);
        const response = await getAuditStatus(auditId, env);
        return new Response(response.body, {
          status: response.status,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // GET /health
      if (pathname === '/health' && method === 'GET') {
        const response = await healthCheck();
        return new Response(response.body, {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // 404
      return new Response(
        JSON.stringify({ success: false, error: 'Endpoint not found' }),
        {
          status: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    } catch (error) {
      console.error('Request error:', error);
      return new Response(
        JSON.stringify({
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        }),
        {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }
  },
};
