interface InstallPrompt extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export function setupPwa(notify: (message: string, error?: boolean) => void) {
  if (!document.querySelector('link[rel="manifest"]') || !('serviceWorker' in navigator) || !window.isSecureContext) return;
  const button = document.getElementById('install-app') as HTMLButtonElement;
  const standalone = () => matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone;
  let pending: InstallPrompt | undefined;
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault(); pending = event as InstallPrompt;
    button.hidden = Boolean(standalone());
  });
  window.addEventListener('appinstalled', () => { pending = undefined; button.hidden = true; notify('应用已安装。'); });
  button.onclick = async () => {
    if (!pending) return notify('请在浏览器菜单中选择「安装应用」或「添加到主屏幕」。');
    const prompt = pending; pending = undefined; button.disabled = true;
    try { await prompt.prompt(); if ((await prompt.userChoice).outcome === 'accepted') button.hidden = true; }
    catch { notify('请通过浏览器菜单安装应用。'); }
    finally { button.disabled = false; }
  };
  navigator.serviceWorker.register(new URL('./sw.js', document.baseURI)).then(() => {
    button.hidden = Boolean(standalone());
  }).catch(() => { button.hidden = true; });
}
