# NexDrive

NexDrive is a Windows desktop client for Google Drive. It keeps transfer queues on disk so large uploads can resume after an interruption or a restart. It also supports download queues, folder sync and a review of publicly shared links.

## Install and connect

1. Download `nex-drive-install.exe` from [Releases](../../releases) and run it.
2. In your Google Cloud project, enable the Google Drive API, configure the OAuth consent screen and create an OAuth client with application type **Desktop app**. Download its JSON file. If the consent screen is in testing mode, add your Google account as a test user.
3. Open NexDrive. Import the OAuth client JSON from the sign-in panel and sign in with Google in your browser. When the browser confirms authorization, return to NexDrive.
4. Open **Files**, choose a test folder and drag in a small file. Open the upload queue to verify its status. Use **Sync** for a persistent folder job. Review each folder and deletion policy before running a sync job.

OAuth credentials and app state stay in your Windows profile. Keep your OAuth JSON and profile contents private. Google Cloud access and the Google Drive service are required for live transfers.

## Build or test locally

Use Node.js 24 or newer and npm on Windows.

```powershell
npm ci
npm test
npm start
npm run dist
```

The installer is written to `dist/nex-drive-install.exe`. The tests exercise upload and download retries, persistence, sync policies and maintenance against a simulated Drive API.

## License

NexDrive is distributed under the [MIT License](LICENSE). Electron and other bundled components retain their own licenses.
