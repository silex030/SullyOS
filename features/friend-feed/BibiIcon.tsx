// features/friend-feed/BibiIcon.tsx
// 哔哔自制图标：原创双气泡线条 SVG，不使用任何外部素材。
import * as React from 'react';

export function BibiIcon({ size = 22, className = '' }: { size?: number; className?: string }) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            className={className}
            aria-hidden="true"
        >
            <path
                d="M4 5.5h12.5a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H10l-3.6 3.1a.6.6 0 0 1-1-.45V15.5H4a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2Z"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinejoin="round"
            />
            <circle cx="7" cy="10.5" r="1.15" fill="currentColor" />
            <circle cx="11" cy="10.5" r="1.15" fill="currentColor" />
            <circle cx="15" cy="10.5" r="1.15" fill="currentColor" />
        </svg>
    );
}
