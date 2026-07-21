const PLACEHOLDER = '/placeholder-cover.svg';

export default function CoverArt({ src, alt }) {
  return (
    <img
      className="cover-art"
      src={src || PLACEHOLDER}
      alt={alt}
      loading="lazy"
      onError={(e) => {
        if (e.currentTarget.src !== window.location.origin + PLACEHOLDER) {
          e.currentTarget.src = PLACEHOLDER;
        }
      }}
    />
  );
}
