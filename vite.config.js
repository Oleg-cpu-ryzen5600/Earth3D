import restart from 'vite-plugin-restart'
import glsl from 'vite-plugin-glsl'

export default {
    root: 'src/',
    publicDir: '../static/',
    // Relative base: works on GitHub Pages (/<repo>/), Vercel, Netlify or any sub-folder
    base: './',
    server: {
        host: true,
        open: !('SANDBOX_URL' in process.env || 'CODESANDBOX_HOST' in process.env)
    },
    build: {
        outDir: '../dist',
        emptyOutDir: true,
        sourcemap: false
    },
    plugins: [
        restart({ restart: ['../static/**'] }),
        glsl()
    ]
}
