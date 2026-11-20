'use client';

import { useState } from 'react';
import { Upload } from 'lucide-react';

interface ImageDropzoneProps {
  onImageSelected: (file: File) => void;
  disabled?: boolean;
}

export function ImageDropzone({ onImageSelected, disabled }: ImageDropzoneProps) {
  const [error, setError] = useState('');

  function selectFile(file?: File) {
    if (disabled || !file) return;

    if (!file.type.startsWith('image/') && !/\.(avif|bmp|gif|heic|heif|jpe?g|png|tiff?|webp)$/i.test(file.name)) {
      setError('Choose an image file.');
      return;
    }

    setError('');
    onImageSelected(file);
  }

  return (
    <div
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        selectFile(event.dataTransfer.files[0]);
      }}
    >
      <label className="flex cursor-pointer flex-col items-center gap-3 rounded-xl border border-dashed border-neutral-400 p-8 text-center focus-within:ring-2 dark:border-neutral-600">
        <Upload aria-hidden="true" className="h-5 w-5" />
        <span className="text-sm font-medium">Drop an image or browse files</span>
        <input
          type="file"
          className="sr-only"
          accept="image/*"
          disabled={disabled}
          aria-describedby={error ? 'image-selection-error' : undefined}
          aria-invalid={Boolean(error)}
          onChange={(event) => {
            selectFile(event.currentTarget.files?.[0]);
            event.currentTarget.value = '';
          }}
        />
      </label>
      {error && <p id="image-selection-error" role="alert" className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}
