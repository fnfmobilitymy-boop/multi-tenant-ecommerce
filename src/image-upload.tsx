import { useI18n } from "./i18n";
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
  const { t, locale, errorText } = useI18n();
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
          <img src={value} alt={t("{label}预览", { label })} />
        ) : (
          <div className="image-placeholder">
            <ImagePlus size={28} />
            <span>{t("还没有图片")}</span>
          </div>
        )}
        <div className="image-upload-controls">
          <label className="button secondary" htmlFor={id}>
            {busy ? (
              <>
                <LoaderCircle size={16} className="spin" />
                {t("上传中…")}
              </>
            ) : (
              <>
                <ImagePlus size={16} />
                {value ? t("更换图片") : t("选择图片")}
              </>
            )}
          </label>
          <input
            id={id}
            className="image-file-input"
            aria-label={t("{label}选择图片", { label })}
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
              {t("移除图片")}
            </button>
          )}
          <p>{t("JPG、PNG、WebP \u00B7 最大 5 MB")}</p>
          <small>{t("选择后自动上传，点击保存后应用到店铺。")}</small>
          {uploaded && (
            <span className="upload-success" role="status">
              {t("已上传，保存后生效")}
            </span>
          )}
        </div>
      </div>
      {error && (
        <p className="error" role="alert">
          {errorText(error)}
        </p>
      )}
    </div>
  );
}
