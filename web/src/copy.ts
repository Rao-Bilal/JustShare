export const COPY = {
  home: {
    title: 'Send files straight to your other device.',
    subtitle:
      'Pair with a 6-digit code or a QR. Files go directly device to device over WebRTC without server storage, and each file is verified with SHA-256 on arrival.',
    sendCardTitle: 'Send files',
    sendCardDesc: 'Start a session to generate a 6-digit code and QR code.',
    sendButton: 'Send files',
    receiveCardTitle: 'Receive files',
    receiveCardDesc: 'Enter a 6-digit code or scan a QR code from another device.',
    receiveButton: 'I have a code',
    howItWorksTitle: 'How it works',
    step1Title: '1. Connect devices',
    step1Desc: 'Open JustShare on both devices. Scan the QR code or enter the 6-digit code to pair.',
    step2Title: '2. Select files',
    step2Desc: 'Choose files or folders on the sender device once pairing is confirmed.',
    step3Title: '3. Verify and save',
    step3Desc: 'Files stream over an encrypted direct channel and are checked with SHA-256 before saving.',
    proofDirect: 'Direct WebRTC connection with no server file storage',
    proofHash: 'Cryptographic SHA-256 verification on all transfers',
    proofNoAccount: 'No account, login, or installation required',
  },
  send: {
    stepper: {
      step1: '1 Pair',
      step2: '2 Choose files',
      step3: '3 Send',
    },
    waitingHeadline: 'Waiting for the other device',
    waitingInstruction: 'Scan with your phone camera, or enter the code on the other device.',
    copyCode: 'Copy code',
    codeCopied: 'Copied',
    expiresIn: (seconds: number) => {
      const mins = Math.floor(seconds / 60);
      const secs = seconds % 60;
      return `Code expires in ${mins}:${secs.toString().padStart(2, '0')}`;
    },
    codeExpired: 'Code expired.',
    generateNewCode: 'Generate new code',
    localhostNotice:
      'Open JustShare using this computer’s network address so your phone can scan the QR.',
    pairedWith: (name: string) => `Paired with ${name}`,
    chooseFilesPrompt: 'Choose files or drag and drop',
    chooseFilesBtn: 'Choose files',
    chooseFolderBtn: 'Choose folder',
    totalSize: (count: number, formattedSize: string) =>
      `${count} file${count === 1 ? '' : 's'} (${formattedSize})`,
    sendToPeer: (name: string) => `Send to ${name}`,
  },
  receive: {
    title: 'Enter pairing code',
    instruction: 'Type the 6-digit code shown on the sender device.',
    joining: 'Joining...',
    scanQrToggle: 'Scan QR instead',
    enterCodeToggle: 'Enter code instead',
    scanQrInstruction: 'Point your camera at the QR code displayed on the sender screen.',
    incomingTitle: (name: string, count: number, size: string) =>
      `${name} wants to send you ${count} file${count === 1 ? '' : 's'} (${size})`,
    storageWarning: (free: string, needed: string) =>
      `Warning: Low disk space. Approximately ${free} free, transfer requires ${needed}.`,
    accept: 'Accept transfer',
    decline: 'Decline',
  },
  transfer: {
    stateGettingReady: 'Getting ready',
    stateHashingDesc: 'Computing file checksums before transmission...',
    stateConnecting: 'Connecting...',
    stateSending: (name: string) => `Sending to ${name}`,
    stateReceiving: (name: string) => `Receiving from ${name}`,
    stateVerifying: 'Checking file integrity...',
    stateVerifyingDesc: 'Verifying SHA-256 hash match...',
    fileCounter: (current: number, total: number) => `File ${current} of ${total}`,
    cancel: 'Cancel transfer',
    cancelConfirmTitle: 'Cancel transfer?',
    cancelConfirmDesc: 'Progress will be lost and you will need to restart the session.',
    cancelConfirmYes: 'Yes, cancel',
    cancelConfirmNo: 'Continue transfer',
  },
  completed: {
    receiverTitle: 'Transfer complete',
    receiverSubtitle: 'All files arrived and passed verification.',
    hashVerifiedBadge: 'Checked: SHA-256 matches',
    hashFailedBadge: 'Verification failed',
    saveFile: 'Save file',
    saveAll: 'Save all files',
    receiveAnother: 'Receive another',
    senderTitle: (name: string) => `Sent to ${name}`,
    senderSubtitle: 'The recipient confirmed all files.',
    sendAnother: 'Send another',
    timeElapsed: (duration: string) => `Completed in ${duration}`,
  },
  errors: {
    peerDisconnected: {
      headline: 'The other device disconnected',
      cause: 'The network connection was closed or the browser was navigated away.',
      nextStep: 'Check that both devices are still online and try pairing again.',
    },
    sessionExpired: {
      headline: 'Pairing code expired',
      cause: 'Pairing codes expire after 10 minutes for security.',
      nextStep: 'Create a new session to generate a fresh pairing code.',
    },
    sessionNotFound: {
      headline: 'Code not found',
      cause: 'The 6-digit code was not recognized or already finished.',
      nextStep: 'Verify the code on the sender screen or generate a new one.',
    },
    sessionFull: {
      headline: 'Session already in use',
      cause: 'Another device has already paired with this code.',
      nextStep: 'Ask the sender to generate a new pairing session.',
    },
    integrityFailed: {
      headline: 'File integrity check failed',
      cause: 'The received file SHA-256 hash does not match the sender hash.',
      nextStep: 'Resend the transfer to ensure complete, uncorrupted delivery.',
    },
    transferCancelled: {
      headline: 'Transfer cancelled',
      cause: 'The transfer was cancelled by user action.',
      nextStep: 'Start a new session to send or receive files.',
    },
    default: {
      headline: 'Transfer could not complete',
      cause: 'An unexpected connection or signaling issue occurred.',
      nextStep: 'Please check your connection and try again.',
    },
    tryAgain: 'Try again',
    home: 'Home',
    details: 'Technical details',
  },
  header: {
    brand: 'JustShare',
    home: 'Home',
  },
  footer: {
    securityNote: 'Direct device-to-device WebRTC · SHA-256 verified · No server file storage',
  },
};
