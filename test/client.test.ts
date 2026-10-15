import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { OverleafClient } from '../src/client.js';

interface CapturedRequest {
  method?: string;
  url?: string;
  headers: IncomingMessage['headers'];
  body: string;
}

async function withServer(
  response: { status?: number; body: unknown; headers?: Record<string, string> },
  run: (baseUrl: string, getRequest: () => CapturedRequest | undefined) => Promise<void>
): Promise<void> {
  let request: CapturedRequest | undefined;
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    request = {
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: Buffer.concat(chunks).toString('utf-8')
    };
    res.writeHead(response.status ?? 200, {
      'Content-Type': 'application/json',
      ...response.headers
    });
    res.end(JSON.stringify(response.body));
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');

  try {
    await run(`http://127.0.0.1:${address.port}`, () => request);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
  }
}

test('createProject creates a blank project and maps the response', async () => {
  await withServer(
    {
      body: { project_id: '0123456789abcdef01234567', owner_ref: 'owner-id' },
      headers: { 'Set-Cookie': 'refreshed=session; Path=/' }
    },
    async (baseUrl, getRequest) => {
      const client = new OverleafClient({
        cookies: { session: 'secret' },
        csrf: 'csrf-token',
        baseUrl
      });

      const created = await client.createProject('  My Paper  ');

      assert.deepEqual(created, {
        id: '0123456789abcdef01234567',
        name: 'My Paper',
        url: `${baseUrl}/project/0123456789abcdef01234567`,
        ownerId: 'owner-id'
      });
      assert.equal(client.getCookie('refreshed'), 'session');
      assert.deepEqual(JSON.parse(getRequest()?.body ?? ''), { projectName: 'My Paper' });
      assert.equal(getRequest()?.method, 'POST');
      assert.equal(getRequest()?.url, '/project/new');
      assert.equal(getRequest()?.headers['content-type'], 'application/json');
      assert.equal(getRequest()?.headers['x-csrf-token'], 'csrf-token');
    }
  );
});

test('createProject requests the example template', async () => {
  await withServer(
    { body: { project_id: '0123456789abcdef01234567' } },
    async (baseUrl, getRequest) => {
      const client = new OverleafClient({ cookies: {}, csrf: 'csrf-token', baseUrl });
      await client.createProject('Example Paper', { template: 'example' });
      assert.deepEqual(JSON.parse(getRequest()?.body ?? ''), {
        projectName: 'Example Paper',
        template: 'example'
      });
    }
  );
});

test('createProject rejects invalid input before making a request', async () => {
  const client = new OverleafClient({ cookies: {}, csrf: 'csrf-token' });
  await assert.rejects(client.createProject('  '), /Project name must not be empty/);
  await assert.rejects(
    client.createProject('Paper', { template: 'unsupported' as 'blank' }),
    /Unsupported project template: unsupported/
  );
});

test('createProject reports HTTP errors and malformed success responses', async () => {
  await withServer(
    { status: 403, body: { message: 'forbidden' } },
    async baseUrl => {
      const client = new OverleafClient({ cookies: {}, csrf: 'csrf-token', baseUrl });
      await assert.rejects(client.createProject('Paper'), /Failed to create project: 403/);
    }
  );

  await withServer(
    { body: {} },
    async baseUrl => {
      const client = new OverleafClient({ cookies: {}, csrf: 'csrf-token', baseUrl });
      await assert.rejects(client.createProject('Paper'), /response did not include a project ID/);
    }
  );
});

test('listComments joins docs over several sockets, not one doc at a time on one socket', async () => {
  const client: any = new OverleafClient({ cookies: { session: 'secret' }, csrf: 'csrf-token' });
  const docs = Array.from({ length: 10 }, (_, i) => ({ _id: `doc${i}`, name: `f${i}.tex` }));
  client.getProjectInfo = async () => ({ rootFolder: [{ docs, folders: [] }] });
  client.getCommentThreads = async () => ({});

  let open = 0;
  const sessions = new Set<object>();
  const joinedBy = new Map<string, object>();
  client.openProjectSocket = async () => {
    const session = {};
    sessions.add(session);
    open++;
    return session;
  };
  client.closeProjectSocket = async () => { open--; };
  client.joinDocument = async (session: object, docId: string) => {
    joinedBy.set(docId, session);
    await new Promise(resolve => setTimeout(resolve, 5));
    const index = Number(docId.slice(3));
    return {
      docId,
      content: 'hello world',
      lines: ['hello world'],
      version: 1,
      type: 'sharejs-text-ot',
      ranges: index === 7 ? { comments: [{ op: { c: 'world', p: 6, t: 'thread7' } }] } : {}
    };
  };

  const comments = await client.listComments('project');

  assert.equal(joinedBy.size, 10);
  assert(sessions.size > 1 && sessions.size <= 4, `expected 2-4 sockets, got ${sessions.size}`);
  assert.equal(open, 0, 'every socket is closed');
  assert.deepEqual(comments.map((c: any) => [c.threadId, c.path]), [['thread7', 'f7.tex']]);
});
