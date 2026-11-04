import { glyphs } from './icons.generated.ts'
/** Product glyphs use one consistent Lucide family. */
export function Glyph({
  name,
  size = 18,
  className,
}: {
  name: keyof typeof glyphs
  size?: number
  className?: string | undefined
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      aria-hidden="true"
      className={className}
      dangerouslySetInnerHTML={{ __html: glyphs[name] }}
    />
  )
}
