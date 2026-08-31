export function saveMediaUrl(url: string, name: string) {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
}

export async function copyImageUrl(url: string) {
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') return;
  const image = new Image();
  image.src = url;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  canvas.getContext('2d')?.drawImage(image, 0, 0);
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((value) => (value ? resolve(value) : reject(new Error('Could not copy image.')))),
  );
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
}
