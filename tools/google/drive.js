// Google Drive: the app's cover letter folder and Docs created from HTML.
// The drive.file permission only reaches files this app created, so the app makes and remembers its own folder.
import { drive as driveApi } from '@googleapis/drive';
import { getUserSetting, setUserSetting } from '../../db/settings.js';

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const DOC_MIME = 'application/vnd.google-apps.document';
export const LETTER_FOLDER_NAME = 'Job Agent Cover Letters';
const FOLDER_SETTING = 'drive.coverLetterFolderId';

/** Thin Drive client (easy to fake in tests): getFile, createFolder, createDocFromHtml. */
export function createDriveClient(auth) {
  const api = driveApi({ version: 'v3', auth });
  return {
    async getFile(id) {
      const { data } = await api.files.get({ fileId: id, fields: 'id, trashed' });
      return data;
    },
    async createFolder(name) {
      const { data } = await api.files.create({ requestBody: { name, mimeType: FOLDER_MIME }, fields: 'id' });
      return data.id;
    },
    /** Uploads HTML and converts it to a Google Doc in the folder. Returns { id, url }. */
    async createDocFromHtml({ name, html, folderId }) {
      const { data } = await api.files.create({
        requestBody: { name, mimeType: DOC_MIME, parents: folderId ? [folderId] : undefined },
        media: { mimeType: 'text/html', body: html },
        fields: 'id, webViewLink',
      });
      return { id: data.id, url: data.webViewLink };
    },
  };
}

export const PREP_FOLDER_NAME = 'Job Agent Meeting Prep';
const PREP_FOLDER_SETTING = 'drive.meetingPrepFolderId';

/** A remembered app folder, or a new one if it was never made, deleted, or trashed. */
async function ensureAppFolder(client, db, name, setting) {
  const known = getUserSetting(db, setting);
  if (known) {
    try {
      const file = await client.getFile(known);
      if (file && !file.trashed) return known;
    } catch {
      // not found or no longer accessible; make a new one
    }
  }
  const id = await client.createFolder(name);
  setUserSetting(db, setting, id);
  return id;
}

/** The cover letter folder. */
export const ensureLetterFolder = (client, db) => ensureAppFolder(client, db, LETTER_FOLDER_NAME, FOLDER_SETTING);

/** The meeting prep folder. */
export const ensurePrepFolder = (client, db) => ensureAppFolder(client, db, PREP_FOLDER_NAME, PREP_FOLDER_SETTING);
