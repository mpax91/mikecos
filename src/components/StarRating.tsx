// Half-star rating, 0.5-5.0 in 0.5 steps — Mike picked this over a
// 100-point critic scale for how fast it is to tap on a phone while still
// giving 10 effective levels. Each star is split into a left/right click
// target (left half = whole - 0.5, right half = whole) rather than
// measuring pointer x-fraction — simpler and just as fast to use.
export function StarRating({
  value,
  onChange,
  readOnly,
  size = 20,
}: {
  value: number | null;
  onChange?: (v: number) => void;
  readOnly?: boolean;
  size?: number;
}) {
  const v = value ?? 0;

  return (
    <div className="star-rating" style={{ ['--star-size' as string]: `${size}px` }}>
      {[1, 2, 3, 4, 5].map((star) => {
        const fillFraction = Math.max(0, Math.min(1, v - (star - 1)));
        return (
          <span key={star} className="star-rating__star" aria-hidden="true">
            <span className="star-rating__star-empty">★</span>
            <span className="star-rating__star-fill" style={{ width: `${fillFraction * 100}%` }}>
              ★
            </span>
            {!readOnly && (
              <>
                <button
                  type="button"
                  className="star-rating__hit star-rating__hit--left"
                  aria-label={`Rate ${star - 0.5} stars`}
                  onClick={() => onChange?.(star - 0.5)}
                />
                <button
                  type="button"
                  className="star-rating__hit star-rating__hit--right"
                  aria-label={`Rate ${star} stars`}
                  onClick={() => onChange?.(star)}
                />
              </>
            )}
          </span>
        );
      })}
      {value !== null && <span className="star-rating__value">{value.toFixed(1)}</span>}
    </div>
  );
}
