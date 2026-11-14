import restart from 'vite-plugin-restart'

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
        sourcemap: false,
        // Textures are imported from src/ so they get hashed file names; never inline them
        assetsInlineLimit: 0
    },
    plugins: [
        restart({ restart: ['../static/**'] })
    ]
}
