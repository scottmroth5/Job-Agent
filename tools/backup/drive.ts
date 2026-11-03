// A minimal Google Drive client for the encrypted backups, over HTTPS with the app's OAuth client. It needs only
// the drive.file scope (already part of npm run google:login), so it can see and change nothing in Drive except
// the files this app created. Uploads are resumable, so backups larger than 5 MB work. Fakeable: tests pass an
// object with the same methods.
import type { OAuth2Client } from 'google-auth-library';

/** What the backups need from Drive; tests pass a fake with the same methods. */
export interface BackupDrive {
  ensureFolder(name: string): Promise<string>;
  upload(folderId: string, name: string, data: Buffer): Promise<{ id: string; name?: string; size?: string }>;
  list(folderId: string): Promise<Array<{ id: string; name: string; size?: string }>>;
  remove(id: string): Promise<void>;
  download(id: string): Promise<Buffer>;
}

const API = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const FOLDER = 'application/vnd.google-apps.folder';

const quote = (s: string) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
// any: a response from google-auth-library or a test fake; its headers are read either way below.
const header = (res: any, name: string) => (typeof res.headers?.get === 'function' ? res.headers.get(name) : res.headers?.[name]);

// any: whatever the request threw; only its status is read.
function scopeHint(err: any) {
  const status = err?.response?.status ?? err?.status;
  if (status === 403 || status === 401) {
    return new Error('Google Drive refused the request. Sign in again with npm run google:login so the app gets the drive.file permission.');
  }
  return err;
}

export function createBackupDrive(auth: Pick<OAuth2Client, 'request'>): BackupDrive {
  // any: Drive's JSON replies; each method reads only the fields it asked for.
  const send = async (opts: Parameters<OAuth2Client['request']>[0]): Promise<any> => {
    try {
      return await auth.request(opts);
    } catch (err) {
      throw scopeHint(err);
    }
  };
  const call = async (opts: Parameters<OAuth2Client['request']>[0]) => (await send(opts)).data;
  return {
    /** The id of the app's backup folder, created on first use. */
    async ensureFolder(name: string) {
      const q = `name = ${quote(name)} and mimeType = '${FOLDER}' and trashed = false`;
      const found = await call({ url: API, params: { q, fields: 'files(id)', spaces: 'drive' } });
      if (found.files?.length) return found.files[0].id;
      return (await call({ url: API, method: 'POST', data: { name, mimeType: FOLDER }, params: { fields: 'id' } })).id;
    },
    /** Uploads bytes as a new file in the folder: a resumable session, then the bytes in one request. */
    async upload(folderId: string, name: string, data: Buffer) {
      const start = await send({
        url: UPLOAD,
        method: 'POST',
        params: { uploadType: 'resumable', fields: 'id,name,size' },
        headers: { 'X-Upload-Content-Type': 'application/octet-stream', 'X-Upload-Content-Length': String(data.length) },
        data: { name, parents: [folderId], mimeType: 'application/octet-stream' },
      });
      const session = header(start, 'location');
      if (!session) throw new Error('Google Drive did not start the upload');
      // The bytes go as they are: gaxios sends a Buffer body unchanged, though its type names only fetch's BodyInit.
      return call({ url: session, method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: data as unknown as BodyInit });
    },
    /** The folder's files: [{ id, name, size }]. */
    async list(folderId: string) {
      const out = [];
      let pageToken: string | undefined;
      do {
        const r = await call({ url: API, params: { q: `${quote(folderId)} in parents and trashed = false`, fields: 'nextPageToken, files(id,name,size)', pageSize: 100, pageToken } });
        out.push(...(r.files ?? []));
        pageToken = r.nextPageToken;
      } while (pageToken);
      return out;
    },
    async remove(id: string) {
      await call({ url: `${API}/${encodeURIComponent(id)}`, method: 'DELETE' });
    },
    async download(id: string) {
      return Buffer.from(await call({ url: `${API}/${encodeURIComponent(id)}`, params: { alt: 'media' }, responseType: 'arraybuffer' }));
    },
  };
}
