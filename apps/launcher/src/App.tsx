import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { onOpenUrl } from '@tauri-apps/plugin-deep-link';

type LaunchState =
  | { status: 'idle' }
  | { status: 'loading'; message: string }
  | { status: 'success'; rustdeskId: string }
  | { status: 'error'; message: string };

export default function App() {
  const [state, setState] = useState<LaunchState>({ status: 'idle' });

  useEffect(() => {
    // Handle deep link on initial launch (URL passed as argument)
    const handleUrl = async (urls: string[]) => {
      const url = urls[0];
      if (!url) return;

      setState({ status: 'loading', message: 'Validating launcher token…' });
      try {
        const result = await invoke<{ rustdeskId: string }>('launch_session', { url });
        setState({ status: 'success', rustdeskId: result.rustdeskId });
        // Auto-close after a short delay
        setTimeout(() => window.close(), 3000);
      } catch (err) {
        setState({ status: 'error', message: String(err) });
      }
    };

    // Listen for deep links while app is running
    const unlisten = onOpenUrl(handleUrl);

    // Check if we were launched with a URL argument
    invoke<string | null>('get_launch_url').then((url) => {
      if (url) handleUrl([url]);
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  return (
    <div className="container">
      <div className="logo">🔌</div>
      <h1>Reboot Remote Launcher</h1>
      <p>Handles deep links for launching RustDesk sessions from the Reboot Remote portal.</p>

      <div className={`status ${state.status === 'idle' ? '' : state.status}`}>
        {state.status === 'idle' && 'Waiting for deep link…'}
        {state.status === 'loading' && (
          <>
            <span className="spinner" />
            {state.message}
          </>
        )}
        {state.status === 'success' && (
          <>RustDesk launched for {state.rustdeskId}. This window will close shortly.</>
        )}
        {state.status === 'error' && <>Error: {state.message}</>}
      </div>
    </div>
  );
}
