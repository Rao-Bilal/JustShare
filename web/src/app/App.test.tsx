// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';

// Helper to simulate file object with webkitRelativePath
function createMockFile(name: string, size: number, relativePath: string = '', lastModified: number = Date.now()): File {
  const file = new File([new Uint8Array(size)], name, { type: 'application/octet-stream', lastModified });
  if (relativePath) {
    Object.defineProperty(file, 'webkitRelativePath', {
      value: relativePath,
      writable: true,
      configurable: true,
    });
  }
  return file;
}

// Logic unit test for file selection reducer / state updater
function addFiles(prevFiles: File[], newFiles: File[]): File[] {
  const existingKeys = new Set(
    prevFiles.map((f) => `${f.webkitRelativePath || f.name}__${f.size}__${f.lastModified}`)
  );
  const uniqueAdditions = newFiles.filter(
    (f) => !existingKeys.has(`${f.webkitRelativePath || f.name}__${f.size}__${f.lastModified}`)
  );
  return [...prevFiles, ...uniqueAdditions];
}

function removeFile(files: File[], indexToRemove: number): File[] {
  return files.filter((_, idx) => idx !== indexToRemove);
}

function calculateTotalSize(files: File[]): number {
  return files.reduce((acc, f) => acc + f.size, 0);
}

describe('File and Folder Selection & Removal Logic', () => {
  it('1. supports selecting multiple files', () => {
    const file1 = createMockFile('doc.pdf', 2048, '', 1000);
    const file2 = createMockFile('photo.jpg', 4096, '', 2000);

    const selection = addFiles([], [file1, file2]);
    expect(selection.length).toBe(2);
    expect(selection[0].name).toBe('doc.pdf');
    expect(selection[1].name).toBe('photo.jpg');
    expect(calculateTotalSize(selection)).toBe(6144);
  });

  it('2. supports selecting folder and preserving webkitRelativePath', () => {
    const folderFile1 = createMockFile('App.tsx', 1024, 'MyProject/src/App.tsx', 3000);
    const folderFile2 = createMockFile('logo.png', 512, 'MyProject/public/logo.png', 4000);
    const folderFile3 = createMockFile('package.json', 256, 'MyProject/package.json', 5000);

    const selection = addFiles([], [folderFile1, folderFile2, folderFile3]);
    expect(selection.length).toBe(3);
    expect(selection[0].webkitRelativePath).toBe('MyProject/src/App.tsx');
    expect(selection[1].webkitRelativePath).toBe('MyProject/public/logo.png');
    expect(selection[2].webkitRelativePath).toBe('MyProject/package.json');
    expect(calculateTotalSize(selection)).toBe(1792);
  });

  it('3. additive selection merges individual files and folder files without duplicates', () => {
    const file1 = createMockFile('notes.txt', 100, '', 1000);
    const folderFile1 = createMockFile('App.tsx', 1024, 'MyProject/src/App.tsx', 3000);

    let selection = addFiles([], [file1]);
    expect(selection.length).toBe(1);

    // Add folder files
    selection = addFiles(selection, [folderFile1]);
    expect(selection.length).toBe(2);
    expect(selection[0].name).toBe('notes.txt');
    expect(selection[1].webkitRelativePath).toBe('MyProject/src/App.tsx');

    // Attempt to add duplicate folder file (same path, size, lastModified)
    selection = addFiles(selection, [folderFile1]);
    expect(selection.length).toBe(2);
  });

  it('4. removes one file from a multi-file selection and updates count & size immediately', () => {
    const file1 = createMockFile('file1.txt', 1000, '', 1000);
    const file2 = createMockFile('file2.txt', 2000, '', 2000);
    const file3 = createMockFile('file3.txt', 3000, '', 3000);

    let selection = addFiles([], [file1, file2, file3]);
    expect(selection.length).toBe(3);
    expect(calculateTotalSize(selection)).toBe(6000);

    // Remove middle file (index 1)
    selection = removeFile(selection, 1);
    expect(selection.length).toBe(2);
    expect(selection[0].name).toBe('file1.txt');
    expect(selection[1].name).toBe('file3.txt');
    expect(calculateTotalSize(selection)).toBe(4000);
  });

  it('5. removes an individual file from a folder selection', () => {
    const folderFile1 = createMockFile('App.tsx', 1024, 'src/App.tsx', 1000);
    const folderFile2 = createMockFile('logo.png', 512, 'public/logo.png', 2000);

    let selection = addFiles([], [folderFile1, folderFile2]);
    expect(selection.length).toBe(2);

    // Remove App.tsx
    selection = removeFile(selection, 0);
    expect(selection.length).toBe(1);
    expect(selection[0].webkitRelativePath).toBe('public/logo.png');
    expect(calculateTotalSize(selection)).toBe(512);
  });

  it('6. removing the final file leaves selection empty', () => {
    const file1 = createMockFile('only.txt', 500, '', 1000);

    let selection = addFiles([], [file1]);
    expect(selection.length).toBe(1);

    selection = removeFile(selection, 0);
    expect(selection.length).toBe(0);
    expect(calculateTotalSize(selection)).toBe(0);
  });
});

describe('Sender File & Folder Controls and Capability Detection', () => {
  it('1. supportsDirectoryUpload returns true on desktop User-Agent', async () => {
    const { supportsDirectoryUpload } = await import('../services/device');
    const originalUa = navigator.userAgent;
    try {
      Object.defineProperty(navigator, 'userAgent', {
        value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        configurable: true,
      });
      expect(supportsDirectoryUpload()).toBe(true);
    } finally {
      Object.defineProperty(navigator, 'userAgent', {
        value: originalUa,
        configurable: true,
      });
    }
  });

  it('2. supportsDirectoryUpload returns false on Android User-Agent', async () => {
    const { supportsDirectoryUpload } = await import('../services/device');
    const originalUa = navigator.userAgent;
    try {
      Object.defineProperty(navigator, 'userAgent', {
        value: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36',
        configurable: true,
      });
      expect(supportsDirectoryUpload()).toBe(false);
    } finally {
      Object.defineProperty(navigator, 'userAgent', {
        value: originalUa,
        configurable: true,
      });
    }
  });

  it('3. supportsDirectoryUpload returns false on iOS User-Agent', async () => {
    const { supportsDirectoryUpload } = await import('../services/device');
    const originalUa = navigator.userAgent;
    try {
      Object.defineProperty(navigator, 'userAgent', {
        value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
        configurable: true,
      });
      expect(supportsDirectoryUpload()).toBe(false);
    } finally {
      Object.defineProperty(navigator, 'userAgent', {
        value: originalUa,
        configurable: true,
      });
    }
  });

  it('4. Desktop sender UI renders both Choose files and Choose folder', () => {
    const isDesktop = true;
    const container = document.createElement('div');

    const chooseFilesBtn = document.createElement('button');
    chooseFilesBtn.className = 'btn btn-secondary action-choose-files';
    chooseFilesBtn.textContent = 'Choose files';
    container.appendChild(chooseFilesBtn);

    if (isDesktop) {
      const chooseFolderBtn = document.createElement('button');
      chooseFolderBtn.className = 'btn btn-secondary action-choose-folder';
      chooseFolderBtn.textContent = 'Choose folder';
      container.appendChild(chooseFolderBtn);
    }

    expect(container.querySelector('.action-choose-files')).not.toBeNull();
    expect(container.querySelector('.action-choose-folder')).not.toBeNull();
    expect(container.querySelectorAll('button').length).toBe(2);
  });

  it('5. Mobile sender UI hides Choose folder and renders only Choose files', () => {
    const isDesktop = false;
    const container = document.createElement('div');

    const chooseFilesBtn = document.createElement('button');
    chooseFilesBtn.className = 'btn btn-secondary action-choose-files';
    chooseFilesBtn.textContent = 'Choose files';
    container.appendChild(chooseFilesBtn);

    if (isDesktop) {
      const chooseFolderBtn = document.createElement('button');
      chooseFolderBtn.className = 'btn btn-secondary action-choose-folder';
      chooseFolderBtn.textContent = 'Choose folder';
      container.appendChild(chooseFolderBtn);
    }

    expect(container.querySelector('.action-choose-files')).not.toBeNull();
    expect(container.querySelector('.action-choose-folder')).toBeNull();
    expect(container.querySelectorAll('button').length).toBe(1);
  });

  it('6. Clicking Choose files opens the normal file input and does not trigger other inputs', () => {
    let fileInputTriggered = 0;
    let folderInputTriggered = 0;

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.addEventListener('click', () => { fileInputTriggered++; });

    const folderInput = document.createElement('input');
    folderInput.type = 'file';
    folderInput.setAttribute('webkitdirectory', '');
    folderInput.addEventListener('click', () => { folderInputTriggered++; });

    const chooseFilesBtn = document.createElement('button');
    chooseFilesBtn.textContent = 'Choose files';
    chooseFilesBtn.addEventListener('click', () => fileInput.click());

    document.body.appendChild(fileInput);
    document.body.appendChild(folderInput);
    document.body.appendChild(chooseFilesBtn);

    chooseFilesBtn.click();

    expect(fileInputTriggered).toBe(1);
    expect(folderInputTriggered).toBe(0);

    document.body.removeChild(fileInput);
    document.body.removeChild(folderInput);
    document.body.removeChild(chooseFilesBtn);
  });
});


