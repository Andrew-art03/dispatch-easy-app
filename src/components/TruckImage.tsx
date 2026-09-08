import truckAsset from "@/assets/ez-18wheeler-side.png.asset.json";

const SIZE_CLASSES = {
  nav: "h-6 w-7",
  sm: "h-8 w-16",
  md: "h-14 w-28",
  lg: "h-20 w-40",
} as const;

export function TruckImage({
  size = "md",
  glowColor,
  className = "",
  monochrome = false,
}: {
  size?: keyof typeof SIZE_CLASSES;
  glowColor: string;
  className?: string;
  monochrome?: boolean;
}) {
  return (
    <img
      src={truckAsset.url}
      alt=""
      aria-hidden="true"
      draggable={false}
      className={`${SIZE_CLASSES[size]} select-none object-contain ${monochrome ? "grayscale" : ""} ${className}`}
      style={{
        filter: `drop-shadow(0 5px 7px rgba(0,0,0,0.6)) drop-shadow(0 8px 12px ${glowColor})`,
      }}
    />
  );
}