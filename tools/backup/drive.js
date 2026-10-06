// A minimal Google Drive client for the encrypted backups, over HTTPS with the app's OAuth client. It needs only
// the drive.file scope (already part of npm run google:login), so it can see and change nothing in Drive except
// the files this app created. Uploads are resumable, so backups larger than 5 MB work. Fakeable: tests pass an
// object with the same methods.
const API = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const FOLDER = 'application/vnd.google-apps.folder';

const quote = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const header = (res, name) => (typeof res.headers?.get === 'function' ? res.headers.get(name) : res.headers?.[name]);

function scopeHint(err) {
  const status = err?.response?.status ?? err?.status;
  if (status === 403 || status === 401) {
    return new Error('Google Drive refused the request. Sign in again with npm run google:login so the app gets the drive.file permission.');
  }
  return err;
}

/** @param {import('google-auth-library').OAuth2Client} auth */
export function createBackupDrive(auth) {
  const send = async (opts) => {
    try {
      return await auth.request(opts);
    } catch (err) {
      throw scopeHint(err);
    }
  };
  const call = async (opts) => (await send(opts)).data;
  return {
    /** The id of the app's backup folder, created on first use. */
    async ensureFolder(name) {
      const q = `name = ${quote(name)} and mimeType = '${FOLDER}' and trashed = false`;
      const found = await call({ url: API, params: { q, fields: 'files(id)', spaces: 'drive' } });
      if (found.files?.length) return found.files[0].id;
      return (await call({ url: API, method: 'POST', data: { name, mimeType: FOLDER }, params: { fields: 'id' } })).id;
    },
    /** Uploads bytes as a new file in the folder: a resumable session, then the bytes in one request. */
    async upload(folderId, name, data) {
      const start = await send({
        url: UPLOAD,
        method: 'POST',
        params: { uploadType: 'resumable', fields: 'id,name,size' },
        headers: { 'X-Upload-Content-Type': 'application/octet-stream', 'X-Upload-Content-Length': String(data.length) },
        data: { name, parents: [folderId], mimeType: 'application/octet-stream' },
      });
      const session = header(start, 'location');
      if (!session) throw new Error('Google Drive did not start the upload');
      return call({ url: session, method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: data });
    },
    /** The folder's files: [{ id, name, size }]. */
    async list(folderId) {
      const out = [];
      let pageToken;
      do {
        const r = await call({ url: API, params: { q: `${quote(folderId)} in parents and trashed = false`, fields: 'nextPageToken, files(id,name,size)', pageSize: 100, pageToken } });
        out.push(...(r.files ?? []));
        pageToken = r.nextPageToken;
      } while (pageToken);
      return out;
    },
    async remove(id) {
      await call({ url: `${API}/${encodeURIComponent(id)}`, method: 'DELETE' });
    },
    async download(id) {
      return Buffer.from(await call({ url: `${API}/${encodeURIComponent(id)}`, params: { alt: 'media' }, responseType: 'arraybuffer' }));
    },
  };
}
