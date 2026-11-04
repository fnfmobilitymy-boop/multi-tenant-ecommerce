import { useId, useState } from "react";
import { ImagePlus, LoaderCircle, X } from "lucide-react";
import { uploadImage } from "./media";
interface Props {
  name: string;
  label: string;
  initialValue?: string;
  wide?: boolean;
  onUploading: (id: string, busy: boolean) => void;
}
export function ImageUpload({
  name,
  label,
  initialValue = "",
  wide = false,
  onUploading,
}: Props) {
  const id = useId();
  const [value, setValue] = useState(initialValue),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [uploaded, setUploaded] = useState(false);
  async function choose(file: File | undefined) {
    if (!file) return;
    setError("");
    setBusy(true);
    setUploaded(false);
    onUploading(id, true);
    try {
      const url = await uploadImage(file);
      setValue(url);
      setUploaded(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      onUploading(id, false);
    }
  }
  return (
    <div className={"image-upload" + (wide ? " wide" : "")}>
      <span className="image-upload-title">{label}</span>
      <input type="hidden" name={name} value={value} />
      <div className="image-upload-body">
        {value ? (
          <img src={value} alt={label + "预览"} />
        ) : (
          <div className="image-placeholder">
            <ImagePlus size={28} />
            <span>还没有图片</span>
          </div>
        )}
        <div className="image-upload-controls">
          <label className="button secondary" htmlFor={id}>
            {busy ? (
              <>
                <LoaderCircle size={16} className="spin" />
                上传中…
              </>
            ) : (
              <>
                <ImagePlus size={16} />
                {value ? "更换图片" : "选择图片"}
              </>
            )}
          </label>
          <input
            id={id}
            className="image-file-input"
            aria-label={label + "选择图片"}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            disabled={busy}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              choose(file);
            }}
          />
          {value && (
            <button
              type="button"
              className="text-button danger"
              disabled={busy}
              onClick={() => {
                setValue("");
                setUploaded(false);
                setError("");
              }}
            >
              <X size={13} />
              移除图片
            </button>
          )}
          <p>JPG、PNG、WebP · 最大 5 MB</p>
          <small>选择后自动上传，点击保存后应用到店铺。</small>
          {uploaded && (
            <span className="upload-success" role="status">
              已上传，保存后生效
            </span>
          )}
        </div>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
