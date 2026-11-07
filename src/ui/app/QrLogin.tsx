import { domBinding, view } from 'effectweb';
import QRCode from 'qrcode';
import LoaderCircle from '@effectweb/lucide/icons/loader-circle';
import Phone from '@effectweb/lucide/icons/phone';

function drawQr(canvas: HTMLCanvasElement, input: () => string) {
  let previous: string | undefined;
  const update = () => {
    const url = input();
    if (url === previous) return;
    previous = url;
    const qr = QRCode.create(url, { errorCorrectionLevel: 'M' });
    const margin = 4,
      scale = 8,
      size = qr.modules.size;
    canvas.width = canvas.height = (size + margin * 2) * scale;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#000000';
    for (let row = 0; row < size; row++)
      for (let col = 0; col < size; col++)
        if (qr.modules.get(row, col))
          context.fillRect((col + margin) * scale, (row + margin) * scale, scale, scale);
  };
  update();
  return {
    update,
    dispose() {
      canvas.width = canvas.height = 0;
    },
  };
}
export const QrLogin = view<{
  token: { url: string; expires: number } | undefined;
  cancel: () => void;
}>((props) => (
  <div class="auth-qr">
    <div class="auth-qr-code">
      {props.token ? (
        <canvas
          use={domBinding(props.token.url, drawQr)}
          role="img"
          aria-label="Scan this QR code with Telegram on your phone"
        />
      ) : (
        <LoaderCircle class="animate-spin text-[var(--accent)]" size={32} />
      )}
    </div>
    <h2 id="auth-title">Log in to Telegram by QR Code</h2>
    <ol>
      <li>Open Telegram on your phone</li>
      <li>
        Go to <strong>Settings → Devices → Link Desktop Device</strong>
      </li>
      <li>Point your phone at this screen to confirm login</li>
    </ol>
    <button class="auth-alternate" onClick={props.cancel}>
      <Phone size={18} />
      Log in by phone number
    </button>
  </div>
));
