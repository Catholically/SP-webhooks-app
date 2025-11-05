import { google } from 'googleapis';
import { Readable } from 'stream';

/**
 * Upload a PDF file to Google Drive
 * @param pdfBuffer - PDF file as Buffer
 * @param fileName - Name of the file (e.g., tracking number)
 * @returns Google Drive file URL
 */
export async function uploadToGoogleDrive(
  pdfBuffer: Buffer,
  fileName: string
): Promise<string> {
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
  const serviceAccountEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;

  if (!folderId || !serviceAccountEmail || !privateKey) {
    throw new Error('Google Drive configuration missing in environment variables');
  }

  // Create JWT client for service account authentication
  const auth = new google.auth.JWT({
    email: serviceAccountEmail,
    key: privateKey.replace(/\\n/g, '\n'), // Handle escaped newlines
    scopes: ['https://www.googleapis.com/auth/drive.file'],
  });

  const drive = google.drive({ version: 'v3', auth });

  // Convert buffer to readable stream
  const stream = Readable.from(pdfBuffer);

  // Upload file to Google Drive
  const fileMetadata = {
    name: `${fileName}.pdf`,
    parents: [folderId],
  };

  const media = {
    mimeType: 'application/pdf',
    body: stream,
  };

  const file = await drive.files.create({
    requestBody: fileMetadata,
    media: media,
    fields: 'id, webViewLink, webContentLink',
  });

  if (!file.data.id) {
    throw new Error('Failed to upload file to Google Drive');
  }

  // Make the file accessible to anyone with the link
  await drive.permissions.create({
    fileId: file.data.id,
    requestBody: {
      role: 'reader',
      type: 'anyone',
    },
  });

  // Return the view link
  const viewLink = file.data.webViewLink ||
                   `https://drive.google.com/file/d/${file.data.id}/view`;

  console.log(`[Google Drive] Uploaded ${fileName}.pdf: ${viewLink}`);

  return viewLink;
}

/**
 * Delete a file from Google Drive by name
 * @param fileName - Name of the file to delete
 */
export async function deleteFromGoogleDrive(fileName: string): Promise<void> {
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
  const serviceAccountEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;

  if (!folderId || !serviceAccountEmail || !privateKey) {
    throw new Error('Google Drive configuration missing in environment variables');
  }

  const auth = new google.auth.JWT({
    email: serviceAccountEmail,
    key: privateKey.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/drive.file'],
  });

  const drive = google.drive({ version: 'v3', auth });

  // Search for file by name in folder
  const response = await drive.files.list({
    q: `name='${fileName}.pdf' and '${folderId}' in parents and trashed=false`,
    fields: 'files(id, name)',
  });

  const files = response.data.files;
  if (!files || files.length === 0) {
    console.log(`[Google Drive] File ${fileName}.pdf not found`);
    return;
  }

  // Delete all matching files
  for (const file of files) {
    if (file.id) {
      await drive.files.delete({ fileId: file.id });
      console.log(`[Google Drive] Deleted ${fileName}.pdf (${file.id})`);
    }
  }
}
