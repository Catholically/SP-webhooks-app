import { google } from 'googleapis';
import { Readable } from 'stream';

/**
 * Create or find folder by path in Shared Drive
 * @param folderPath - Array of folder names (e.g., ['PDF', '11', '11052025'])
 * @param parentFolderId - Parent folder ID to start from
 * @returns Folder ID of the final folder in the path
 */
async function ensureFolderPath(
  folderPath: string[],
  parentFolderId: string
): Promise<string> {
  const serviceAccountEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;

  if (!serviceAccountEmail || !privateKey) {
    throw new Error('Google Drive configuration missing');
  }

  const auth = new google.auth.JWT({
    email: serviceAccountEmail,
    key: privateKey.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/drive'],
  });

  const drive = google.drive({ version: 'v3', auth });

  let currentParent = parentFolderId;

  // Create/find each folder in the path
  for (const folderName of folderPath) {
    // Check if folder exists
    const searchResponse = await drive.files.list({
      q: `name='${folderName}' and '${currentParent}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: 'files(id, name)',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });

    if (searchResponse.data.files && searchResponse.data.files.length > 0) {
      // Folder exists, use it
      currentParent = searchResponse.data.files[0].id!;
      console.log(`[Google Drive] Found existing folder: ${folderName} (${currentParent})`);
    } else {
      // Create folder
      const createResponse = await drive.files.create({
        requestBody: {
          name: folderName,
          mimeType: 'application/vnd.google-apps.folder',
          parents: [currentParent],
        },
        fields: 'id',
        supportsAllDrives: true,
      });
      currentParent = createResponse.data.id!;
      console.log(`[Google Drive] Created folder: ${folderName} (${currentParent})`);
    }
  }

  return currentParent;
}

/**
 * Upload a PDF file to Google Drive with date-based folder structure
 * @param pdfBuffer - PDF file as Buffer
 * @param fileName - Name of the file (without .pdf extension) - typically order number
 * @param type - Type of document ('label' -> fileName.pdf, 'customs' -> fileName_d.pdf)
 * @returns Google Drive file URL
 */
export async function uploadToGoogleDrive(
  pdfBuffer: Buffer,
  fileName: string,
  type: 'label' | 'customs' = 'customs'
): Promise<string> {
  const baseFolderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
  const serviceAccountEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;

  if (!baseFolderId || !serviceAccountEmail || !privateKey) {
    throw new Error('Google Drive configuration missing in environment variables');
  }

  // Create date-based folder path: MM/mmddyyyy
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0'); // 11
  const day = String(now.getDate()).padStart(2, '0');         // 05
  const year = now.getFullYear();                             // 2025
  const dateFolder = `${month}${day}${year}`;                 // 11052025

  const folderPath = [month, dateFolder];

  console.log(`[Google Drive] Creating folder structure: ${folderPath.join('/')}`);
  const targetFolderId = await ensureFolderPath(folderPath, baseFolderId);

  // Create JWT client for service account authentication
  const auth = new google.auth.JWT({
    email: serviceAccountEmail,
    key: privateKey.replace(/\\n/g, '\n'), // Handle escaped newlines
    scopes: ['https://www.googleapis.com/auth/drive'],
  });

  const drive = google.drive({ version: 'v3', auth });

  // Convert buffer to readable stream
  const stream = Readable.from(pdfBuffer);

  // Determine final filename based on type
  const finalFileName = type === 'label'
    ? `${fileName}.pdf`           // e.g., 35622182025.pdf (label)
    : `${fileName}_d.pdf`;        // e.g., 35622182025_d.pdf (customs)

  // Upload file to Google Drive
  const fileMetadata = {
    name: finalFileName,
    parents: [targetFolderId],
  };

  const media = {
    mimeType: 'application/pdf',
    body: stream,
  };

  const file = await drive.files.create({
    requestBody: fileMetadata,
    media: media,
    fields: 'id, webViewLink, webContentLink',
    supportsAllDrives: true,
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
    supportsAllDrives: true,
  });

  // Return the view link
  const viewLink = file.data.webViewLink ||
                   `https://drive.google.com/file/d/${file.data.id}/view`;

  console.log(`[Google Drive] Uploaded ${finalFileName}: ${viewLink}`);

  return viewLink;
}

/**
 * Download PDF from URL and upload to Google Drive
 * @param url - URL to download PDF from
 * @param fileName - Name for the file (without .pdf extension) - typically order number
 * @param type - Type of document ('label' -> fileName.pdf, 'customs' -> fileName_d.pdf)
 * @returns Google Drive file URL
 */
export async function downloadAndUploadToGoogleDrive(
  url: string,
  fileName: string,
  type: 'label' | 'customs' = 'customs'
): Promise<string> {
  console.log(`[Google Drive] Downloading PDF from: ${url}`);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download PDF: ${response.status} ${response.statusText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const pdfBuffer = Buffer.from(arrayBuffer);

  console.log(`[Google Drive] Downloaded ${pdfBuffer.length} bytes`);

  return uploadToGoogleDrive(pdfBuffer, fileName, type);
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
    scopes: ['https://www.googleapis.com/auth/drive'],
  });

  const drive = google.drive({ version: 'v3', auth });

  // Search for file by name in folder
  const response = await drive.files.list({
    q: `name='${fileName}.pdf' and '${folderId}' in parents and trashed=false`,
    fields: 'files(id, name)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });

  const files = response.data.files;
  if (!files || files.length === 0) {
    console.log(`[Google Drive] File ${fileName}.pdf not found`);
    return;
  }

  // Delete all matching files
  for (const file of files) {
    if (file.id) {
      await drive.files.delete({
        fileId: file.id,
        supportsAllDrives: true,
      });
      console.log(`[Google Drive] Deleted ${fileName}.pdf (${file.id})`);
    }
  }
}
