"""Per-ecosystem adapter extraction — JVM/.NET family.

Split from test/dependency-existence-check.test.py (issue #2005 Long File refactor).
"""

from ._common import *  # noqa: F401,F403
from ._common import _HERE, _SCRIPTS, _netloc  # noqa: F401
from ._bases import AdapterExtractionBase  # noqa: E402

class AdapterExtractionJvmDotnetTests(AdapterExtractionBase):
    def test_java_pom_xml(self):
        a = dec.JavaAdapter()
        text = (
            '<project xmlns="http://maven.apache.org/POM/4.0.0">'
            "<dependencies>"
            "<dependency><groupId>com.example</groupId><artifactId>lib</artifactId>"
            "<version>1.2</version><scope>test</scope></dependency>"
            "<dependency><groupId>org.foo</groupId><artifactId>bar</artifactId></dependency>"
            "</dependencies></project>"
        )
        deps = dict(self.names(a, text, self.P("pom.xml")))
        self.assertEqual(deps, {"com.example:lib": "1.2", "org.foo:bar": None})

    def test_java_gradle(self):
        a = dec.JavaAdapter()
        text = (
            "dependencies {\n"
            "    implementation 'com.example:lib:1.2'\n"
            "    api group: 'org.foo', name: 'bar', version: '2.0'\n"
            "    compileOnly 'com.opt:opt:1.0'\n"
            "    implementation(\n"
            "        group: 'com.multi',\n"
            "        name: 'multi',\n"
            "        version: '3.0'\n"
            "    )\n"
            "    testImplementation 'junit:junit:4.13'\n"
            "}\n"
        )
        names = {n for n, _ in self.names(a, text, self.P("build.gradle"))}
        self.assertEqual(names, {"com.example:lib", "org.foo:bar", "com.opt:opt",
                                 "com.multi:multi", "junit:junit"})

    def test_dotnet_csproj_packages_config_and_central(self):
        a = dec.DotnetAdapter()
        csproj = (
            '<Project Sdk="Microsoft.NET.Sdk">'
            "<ItemGroup>"
            '<PackageReference Include="Newtonsoft.Json" Version="13.0.3" />'
            '<PackageReference Include="NoVersion" />'
            '<ProjectReference Include="../Other/Other.csproj" />'
            "</ItemGroup></Project>"
        )
        names = {n for n, _ in self.names(a, csproj, self.P("App.csproj"))}
        self.assertEqual(names, {"Newtonsoft.Json", "NoVersion"})
        pc = '<packages><package id="log4net" version="2.0.8" /></packages>'
        self.assertEqual(dict(self.names(a, pc, self.P("packages.config"))), {"log4net": "2.0.8"})
        props = (
            "<Project><ItemGroup>"
            '<PackageVersion Include="Newtonsoft.Json" Version="13.0.3" />'
            "</ItemGroup></Project>"
        )
        self.assertEqual(dict(self.names(a, props, self.P("Directory.Packages.props"))),
                         {"Newtonsoft.Json": "13.0.3"})
