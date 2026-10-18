import { useState } from 'react';
import { formatBytes } from '../services/format';
import { getFileIconComponent, IconGrid, IconList, IconTrash, IconMoreVertical, IconDownload, IconHardDrive, IconInbox, IconSend } from './Icons';
import { Button } from './Button';

export interface HistoryItem {
  id: string;
  name: string;
  size: number;
  direction: 'sent' | 'received';
  timestamp: number;
  peerName?: string;
  verified?: boolean;
  blob?: Blob;
}

interface FileManagerDashboardProps {
  history: HistoryItem[];
  onClearHistory: () => void;
  onSendNew: () => void;
  onReceiveNew: () => void;
  storageEstimate?: { used: number; quota: number } | null;
}

export function FileManagerDashboard({
  history,
  onClearHistory,
  onSendNew,
  onReceiveNew,
  storageEstimate,
}: FileManagerDashboardProps) {
  const [viewMode, setViewMode] = useState<'grid' | 'table'>('grid');
  const [activeTab, setActiveTab] = useState<'all' | 'received' | 'sent'>('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);

  const filteredItems = history.filter((item) => {
    if (activeTab === 'received' && item.direction !== 'received') return false;
    if (activeTab === 'sent' && item.direction !== 'sent') return false;
    if (searchTerm.trim() && !item.name.toLowerCase().includes(searchTerm.toLowerCase())) return false;
    return true;
  });

  const totalUsedSize = history.reduce((acc, item) => acc + item.size, 0);

  const handleDownload = (item: HistoryItem) => {
    if (!item.blob) return;
    const url = URL.createObjectURL(item.blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = item.name;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="dashboard-container">
      {/* Sidebar Navigation */}
      <aside className="dashboard-sidebar">
        <div className="sidebar-section">
          <span className="sidebar-section-title">Navigation</span>
          <button
            type="button"
            className={`sidebar-nav-btn ${activeTab === 'all' ? 'active' : ''}`}
            onClick={() => setActiveTab('all')}
          >
            <IconHardDrive size={18} />
            <span>All Files</span>
            <span className="sidebar-badge">{history.length}</span>
          </button>
          <button
            type="button"
            className={`sidebar-nav-btn ${activeTab === 'received' ? 'active' : ''}`}
            onClick={() => setActiveTab('received')}
          >
            <IconInbox size={18} />
            <span>Received</span>
            <span className="sidebar-badge">
              {history.filter((h) => h.direction === 'received').length}
            </span>
          </button>
          <button
            type="button"
            className={`sidebar-nav-btn ${activeTab === 'sent' ? 'active' : ''}`}
            onClick={() => setActiveTab('sent')}
          >
            <IconSend size={18} />
            <span>Sent</span>
            <span className="sidebar-badge">
              {history.filter((h) => h.direction === 'sent').length}
            </span>
          </button>
        </div>

        {/* Storage Quota Widget */}
        <div className="sidebar-storage-widget">
          <div className="storage-widget-header">
            <span className="storage-widget-title">Browser Storage</span>
            <span className="storage-widget-val tabular-numbers">{formatBytes(totalUsedSize)}</span>
          </div>
          <div className="storage-progress-bar">
            <div
              className="storage-progress-fill"
              style={{
                width: storageEstimate
                  ? `${Math.min(100, (storageEstimate.used / storageEstimate.quota) * 100)}%`
                  : '8%',
              }}
            />
          </div>
          <span className="storage-widget-meta">
            {storageEstimate
              ? `${formatBytes(storageEstimate.used)} of ${formatBytes(storageEstimate.quota)} used`
              : 'IndexedDB Zero-Knowledge Cache'}
          </span>
        </div>

        {history.length > 0 && (
          <div className="sidebar-clear-action">
            <Button
              variant="secondary"
              className="btn-clear-history"
              onClick={onClearHistory}
              icon={<IconTrash size={16} />}
            >
              Clear Recent History
            </Button>
          </div>
        )}
      </aside>

      {/* Main Files Area */}
      <div className="dashboard-content">
        {/* Controls Bar: Search, View Switcher, Quick Actions */}
        <div className="dashboard-header-bar">
          <div className="dashboard-search-wrap">
            <input
              type="text"
              placeholder="Search transfers..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="dashboard-search-input"
            />
          </div>

          <div className="dashboard-toolbar-actions">
            <div className="view-mode-toggle" role="group" aria-label="View layout">
              <button
                type="button"
                className={`view-toggle-btn ${viewMode === 'grid' ? 'active' : ''}`}
                onClick={() => setViewMode('grid')}
                title="Grid view"
                aria-label="Grid view"
              >
                <IconGrid size={18} />
              </button>
              <button
                type="button"
                className={`view-toggle-btn ${viewMode === 'table' ? 'active' : ''}`}
                onClick={() => setViewMode('table')}
                title="Table list view"
                aria-label="Table list view"
              >
                <IconList size={18} />
              </button>
            </div>

            <Button variant="primary" onClick={onSendNew}>
              Send Files
            </Button>
            <Button variant="secondary" onClick={onReceiveNew}>
              Receive
            </Button>
          </div>
        </div>

        {/* Empty State */}
        {filteredItems.length === 0 ? (
          <div className="dashboard-empty-card">
            <div className="dashboard-empty-icon" aria-hidden="true">
              <IconInbox size={42} />
            </div>
            <h3>No transfers yet</h3>
            <p>Files you send or receive will appear here with instant download and verification.</p>
            <div style={{ display: 'flex', gap: '12px', marginTop: '16px' }}>
              <Button variant="primary" onClick={onSendNew}>
                Start New Transfer
              </Button>
            </div>
          </div>
        ) : viewMode === 'grid' ? (
          /* Grid View with Thumbnails & Metadata */
          <div className="file-manager-grid">
            {filteredItems.map((item) => (
              <div key={item.id} className="file-grid-card">
                <div className="grid-card-thumb" aria-hidden="true">
                  {getFileIconComponent(item.name, 36)}
                </div>

                <div className="grid-card-details">
                  <span className="grid-card-name" title={item.name}>
                    {item.name}
                  </span>
                  <div className="grid-card-sub">
                    <span className="tabular-numbers">{formatBytes(item.size)}</span>
                    <span className="dot-divider">•</span>
                    <span className={`direction-tag ${item.direction}`}>
                      {item.direction === 'received' ? 'Received' : 'Sent'}
                    </span>
                  </div>
                  {item.peerName && (
                    <span className="grid-card-peer">
                      {item.direction === 'received' ? 'From: ' : 'To: '}
                      {item.peerName}
                    </span>
                  )}
                </div>

                <div className="grid-card-actions">
                  {item.blob && (
                    <Button
                      variant="secondary"
                      className="btn-grid-download"
                      onClick={() => handleDownload(item)}
                      title="Download file"
                      icon={<IconDownload size={16} />}
                    >
                      Save
                    </Button>
                  )}
                  <div className="grid-menu-wrap">
                    <button
                      type="button"
                      className="btn-icon-menu"
                      onClick={() => setOpenMenuId(openMenuId === item.id ? null : item.id)}
                      aria-label="File options"
                    >
                      <IconMoreVertical size={16} />
                    </button>
                    {openMenuId === item.id && (
                      <div className="file-menu-dropdown">
                        {item.blob && (
                          <button
                            type="button"
                            className="dropdown-item"
                            onClick={() => {
                              handleDownload(item);
                              setOpenMenuId(null);
                            }}
                          >
                            <IconDownload size={14} /> Download
                          </button>
                        )}
                        <button
                          type="button"
                          className="dropdown-item"
                          onClick={() => {
                            navigator.clipboard.writeText(item.name);
                            setOpenMenuId(null);
                          }}
                        >
                          Copy Name
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          /* Table / List View */
          <div className="file-manager-table-wrap">
            <table className="file-manager-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Size</th>
                  <th>Direction</th>
                  <th>Peer</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredItems.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <div className="table-file-name-cell">
                        <span className="table-file-icon">{getFileIconComponent(item.name, 18)}</span>
                        <span className="table-name-text" title={item.name}>
                          {item.name}
                        </span>
                      </div>
                    </td>
                    <td className="tabular-numbers">{formatBytes(item.size)}</td>
                    <td>
                      <span className={`direction-tag ${item.direction}`}>
                        {item.direction === 'received' ? 'Received' : 'Sent'}
                      </span>
                    </td>
                    <td>{item.peerName || '—'}</td>
                    <td>
                      <span className="table-status-badge">
                        {item.verified !== false ? 'Verified' : 'Unchecked'}
                      </span>
                    </td>
                    <td>
                      <div className="table-actions-cell">
                        {item.blob && (
                          <Button
                            variant="secondary"
                            onClick={() => handleDownload(item)}
                            icon={<IconDownload size={14} />}
                          >
                            Save
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
