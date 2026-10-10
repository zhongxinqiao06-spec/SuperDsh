import localFont from 'next/font/local'

// Keep the original families and CSS variables, with no build-time font fetch.
export const sans = localFont({
  src: './fonts/geist/geist-latin-wght-normal.woff2',
  weight: '400 700',
  style: 'normal',
  display: 'swap',
  variable: '--font-geist',
})

export const mono = localFont({
  src: './fonts/geist-mono/geist-mono-latin-wght-normal.woff2',
  weight: '400 600',
  style: 'normal',
  display: 'swap',
  variable: '--font-geist-mono',
})

export const serif = localFont({
  src: [
    {
      path: './fonts/instrument-serif/instrument-serif-latin-400-normal.woff2',
      weight: '400',
      style: 'normal',
    },
    {
      path: './fonts/instrument-serif/instrument-serif-latin-400-italic.woff2',
      weight: '400',
      style: 'italic',
    },
  ],
  display: 'swap',
  variable: '--font-instrument-serif',
})

export const brand = localFont({
  src: './fonts/caveat/caveat-latin-wght-normal.woff2',
  weight: '400 700',
  style: 'normal',
  display: 'swap',
  variable: '--font-caveat',
})
