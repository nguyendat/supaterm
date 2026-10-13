require 'json'
package = JSON.parse(File.read(File.join(__dir__, 'package.json')))
Pod::Spec.new do |s|
  s.name = 'SupacodePushPreview'
  s.version = package['version']
  s.summary = 'Local decryption of Supacode notification previews.'
  s.homepage = 'https://supacode.sh'
  s.license = { :type => 'MIT' }
  s.author = { 'Supacode' => 'hello@supacode.sh' }
  s.platforms = { :ios => '18.0' }
  s.source = { :path => '.' }
  s.source_files = 'ios/**/*.swift', 'Sources/PushPreviewCore/**/*.swift'
  s.frameworks = 'CryptoKit', 'Security'
  s.swift_version = '5.9'
  s.dependency 'ExpoModulesCore'
end
