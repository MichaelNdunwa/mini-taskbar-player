const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('spotify', {
  // Data
  getStoredCredentials: ()       => ipcRenderer.invoke('get-stored-credentials'),
  saveCredentials:      (data)   => ipcRenderer.invoke('save-credentials', data),
  startAuth:            (data)   => ipcRenderer.invoke('start-auth', data),
  logout:               ()       => ipcRenderer.invoke('logout'),

  // Controls
  playPause:   ()       => ipcRenderer.invoke('play-pause'),
  nextTrack:   ()       => ipcRenderer.invoke('next-track'),
  prevTrack:   ()       => ipcRenderer.invoke('prev-track'),
  toggleSave:  (data)   => ipcRenderer.invoke('toggle-save', data),
  seek:        (data)   => ipcRenderer.invoke('seek', data),
  openSpotify: ()       => ipcRenderer.invoke('open-spotify'),
  openSettings: ()      => ipcRenderer.invoke('open-settings'),

  // Events from main
  onPlaybackState: (cb) => ipcRenderer.on('playback-state', (_, data) => cb(data)),
  onAuthSuccess:   (cb) => ipcRenderer.on('auth-success',   ()        => cb()),
  onAuthError:     (cb) => ipcRenderer.on('auth-error',     (_, msg)  => cb(msg)),
});
